/**
 * Daily live cross-tenant isolation canary.
 *
 * Logs in as TWO real tenants (real password auth, not DB impersonation) against
 * PRODUCTION and exercises the same /ycode/api/* surface the builder UI uses:
 * full content CRUD (pages, collections, fields, items, components, styles,
 * colors, locales, assets, settings, globals), user management, API keys, MCP
 * tokens (incl. actually authenticating an MCP session), webhooks, and publish.
 * Then attacks every created resource from the OTHER tenant's session and
 * verifies — via the VICTIM'S OWN subsequent read, not just the attacker's HTTP
 * status — that nothing was ever read, written, or deleted cross-tenant.
 *
 * Design rationale + full incident history: see
 * TENANT-ISOLATION-AND-CLONE-PLAN.md ("GO-BACK PROTOCOL" + "EXHAUSTIVE LIVE API
 * TEST" sections). This script is the permanent form of the one-off test that
 * found two real bugs on 2026-06-30/07-01 (a broken admin-op carve-out and a
 * missing app_metadata claim on the minted RLS token).
 *
 * Canary tenants (fixed, permanent — see TENANT-ISOLATION-AND-CLONE-PLAN.md):
 *   high900 (tenant A) / assasx7 (tenant B). Both are marked in
 *   tenant_registry.description as permanent test fixtures — never real
 *   customers, never touched by orphan cleanup (they have live registry rows).
 *
 * Run: SUPABASE_SERVICE_ROLE_KEY=... SUPABASE_URL=... SUPABASE_ANON_KEY=... \
 *      npx tsx scripts/tenant-isolation-live-check.ts
 *
 * Exit code 0 = all checks passed. Exit code 1 = at least one check failed
 * (treat as a P0 security incident — see the GO-BACK PROTOCOL immediate action).
 *
 * Safety: every created resource is deleted in a try/finally, so a mid-run
 * crash still attempts full cleanup. Each run mints a fresh random password
 * for both canary owners via the Admin API (never stored, never reused).
 */
import { writeFileSync } from 'node:fs';
import crypto from 'node:crypto';
import { createBrowserClient } from '@supabase/ssr';
import WS from 'ws';

(globalThis as unknown as { WebSocket: unknown }).WebSocket = WS;

const SUPABASE_URL = requireEnv('SUPABASE_URL');
const SUPABASE_ANON_KEY = requireEnv('SUPABASE_ANON_KEY');
const SUPABASE_SERVICE_ROLE_KEY = requireEnv('SUPABASE_SERVICE_ROLE_KEY');

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`Missing required env var: ${name}`);
    process.exit(1);
  }
  return v;
}

// ---- Fixed canary fixtures (see file header) ----
const CANARIES = {
  A: { label: 'high900', host: 'high900.masjidweb.com', userId: '4688cef3-fe98-49dc-a9ed-a8c0c5dba3a4', email: 'high900@masjidweb.com', tenantId: '64ceee8e-2a08-46b6-94d2-11cd5554c4a7' },
  B: { label: 'assasx7', host: 'assasx7.masjidweb.com', userId: '99834db8-ff95-43b5-892e-680ac6cccd19', email: 'demox7@masjidweb.com', tenantId: '3ef8bf9e-4341-426c-9696-ba2c2db7adfa' },
};

type Result = { area: string; step: string; ok: boolean; status?: number; detail?: string };
const results: Result[] = [];
function record(area: string, step: string, ok: boolean, status?: number, detail?: string) {
  results.push({ area, step, ok, status, detail });
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${area} :: ${step}${status ? ` (${status})` : ''}${detail ? ` — ${detail}` : ''}`);
}

/**
 * Records an api() result against a set of acceptable statuses, auto-attaching the
 * response body as diagnostic detail WHENEVER IT FAILS — so a future failure always
 * shows what actually went wrong instead of a bare status code. Found necessary
 * after the first real CI run recorded a failure with no detail at all.
 */
function recordApi(area: string, step: string, r: { status: number; json: any; text: string }, okStatuses: number[]): void {
  const ok = okStatuses.includes(r.status);
  record(area, step, ok, r.status, ok ? undefined : JSON.stringify(r.json ?? r.text)?.slice(0, 300));
}

async function resetPasswordAndLogin(host: string, userId: string, email: string): Promise<{ cookie: string }> {
  const freshPassword = crypto.randomBytes(24).toString('base64');
  const resetRes = await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${userId}`, {
    method: 'PUT',
    headers: { apikey: SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: freshPassword }),
  });
  if (!resetRes.ok) throw new Error(`Password reset failed for ${email}: ${resetRes.status} ${await resetRes.text()}`);

  const cookieOptions = tenantScopedCookieOptions(host, SUPABASE_URL);
  const store: { name: string; value: string }[] = [];
  const client = createBrowserClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    cookieOptions,
    cookies: {
      getAll: () => store,
      setAll: (cookiesToSet: { name: string; value: string }[]) => {
        for (const { name, value } of cookiesToSet) {
          const idx = store.findIndex((c) => c.name === name);
          if (idx >= 0) store[idx] = { name, value };
          else store.push({ name, value });
        }
      },
    },
  });
  const { error } = await client.auth.signInWithPassword({ email, password: freshPassword });
  if (error) throw new Error(`Login failed for ${email}: ${error.message}`);

  const cookie = store.filter((c) => c.value).map((c) => `${c.name}=${encodeURIComponent(c.value)}`).join('; ');
  return { cookie };
}

/** Mirrors lib/supabase-cookie-domain.ts tenantScopedAuthCookieName (host-only, per-host cookie name). */
function tenantScopedCookieOptions(hostname: string, projectUrl: string): { name: string } {
  const ref = new URL(projectUrl).hostname.split('.')[0];
  const host = hostname.replace(/:\d+$/, '').toLowerCase();
  const label = host.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'host';
  return { name: `sb-${ref}-${label}-auth-token` };
}

type Tenant = { label: string; host: string; cookie: string; tenantId: string };

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * A one-off 5xx (cold start, transient infra blip) shouldn't page anyone — only a
 * REPRODUCIBLE failure should. Retry once after a short delay before recording a
 * result; a genuine bug fails the same way twice, a blip clears on retry. Found
 * necessary in production: the first real CI run of this canary hit exactly this
 * (a single transient 500 on an otherwise-passing endpoint, confirmed non-reproducing
 * moments later) — see TENANT-ISOLATION-AND-CLONE-PLAN.md.
 */
async function api(tenant: Tenant, method: string, path: string, body?: unknown): Promise<{ status: number; json: any; text: string }> {
  const attempt = async () => {
    const res = await fetch(`https://${tenant.host}${path}`, {
      method,
      headers: { Cookie: tenant.cookie, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let json: any = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* not json */
    }
    return { status: res.status, json, text };
  };

  const first = await attempt();
  if (first.status < 500) return first;
  await sleep(1500);
  return attempt();
}

const createdA: Record<string, string> = {};
const createdB: Record<string, string> = {};

async function contentCrud(t: Tenant, created: Record<string, string>) {
  const area = `${t.label}:content`;

  {
    const c = await api(t, 'POST', '/ycode/api/folders', { name: 'Canary Folder', slug: `canary-folder-${Date.now()}` });
    recordApi(area, 'create page folder', c, [200, 201]);
    if (c.json?.data?.id) created.pageFolderId = c.json.data.id;
  }
  {
    const c = await api(t, 'POST', '/ycode/api/pages', { name: 'Canary Page', slug: `canary-page-${Date.now()}` });
    recordApi(area, 'create page', c, [200, 201]);
    if (c.json?.data?.id) created.pageId = c.json.data.id;
  }
  if (created.pageId) {
    recordApi(area, 'get page', await api(t, 'GET', `/ycode/api/pages/${created.pageId}`), [200]);
    recordApi(area, 'list pages', await api(t, 'GET', '/ycode/api/pages'), [200]);
    recordApi(area, 'update page', await api(t, 'PUT', `/ycode/api/pages/${created.pageId}`, { name: 'Canary Page Renamed' }), [200]);
    const dup = await api(t, 'POST', `/ycode/api/pages/${created.pageId}/duplicate`);
    recordApi(area, 'duplicate page', dup, [200, 201]);
    if (dup.json?.data?.id) created.pageIdDup = dup.json.data.id;
    recordApi(area, 'get layers', await api(t, 'GET', `/ycode/api/layers?page_id=${created.pageId}`), [200]);
  }

  {
    const c = await api(t, 'POST', '/ycode/api/collections', { name: 'Canary Collection' });
    recordApi(area, 'create collection', c, [200, 201]);
    if (c.json?.data?.id) created.collectionId = c.json.data.id;
  }
  if (created.collectionId) {
    recordApi(area, 'get collection', await api(t, 'GET', `/ycode/api/collections/${created.collectionId}`), [200]);
    recordApi(area, 'list collections', await api(t, 'GET', '/ycode/api/collections'), [200]);
    recordApi(area, 'update collection', await api(t, 'PUT', `/ycode/api/collections/${created.collectionId}`, { name: 'Canary Collection Renamed' }), [200]);

    const f = await api(t, 'POST', `/ycode/api/collections/${created.collectionId}/fields`, { name: 'Title', type: 'text' });
    recordApi(area, 'create collection field', f, [200, 201]);
    const fieldId = f.json?.data?.id;
    if (fieldId) created.fieldId = fieldId;
    if (fieldId) {
      recordApi(area, 'update collection field', await api(t, 'PUT', `/ycode/api/collections/${created.collectionId}/fields/${fieldId}`, { name: 'Title Updated' }), [200]);
    }

    const itemBody: Record<string, unknown> = { name: 'Canary Item' };
    if (fieldId) itemBody[fieldId] = 'canary value';
    const it = await api(t, 'POST', `/ycode/api/collections/${created.collectionId}/items`, itemBody);
    recordApi(area, 'create collection item', it, [200, 201]);
    const itemId = it.json?.data?.id;
    if (itemId) created.itemId = itemId;
    if (itemId) {
      recordApi(area, 'get collection item', await api(t, 'GET', `/ycode/api/collections/${created.collectionId}/items/${itemId}`), [200]);
      recordApi(area, 'list collection items', await api(t, 'GET', `/ycode/api/collections/${created.collectionId}/items`), [200]);
      const iu = await api(t, 'PUT', `/ycode/api/collections/${created.collectionId}/items/${itemId}`, fieldId ? { values: { [fieldId]: 'updated value' } } : {});
      recordApi(area, 'update collection item', iu, [200]);
    }
  }

  {
    const c = await api(t, 'POST', '/ycode/api/components', { name: 'Canary Component', layers: [] });
    recordApi(area, 'create component', c, [200, 201]);
    if (c.json?.data?.id) created.componentId = c.json.data.id;
  }
  if (created.componentId) {
    recordApi(area, 'get component', await api(t, 'GET', `/ycode/api/components/${created.componentId}`), [200]);
    recordApi(area, 'list components', await api(t, 'GET', '/ycode/api/components'), [200]);
  }

  {
    // Name must be unique per run: layer_styles has a UNIQUE index on
    // (tenant_id, name, is_published) that does NOT exclude soft-deleted rows
    // (deleted_at IS NOT NULL), so a fixed name collides with yesterday's
    // soft-deleted canary row and the insert 500s. (This is itself a real, if
    // narrow, app-level quirk independent of tenant isolation — see
    // TENANT-ISOLATION-AND-CLONE-PLAN.md — but the canary's own fix is simply
    // to use a unique name, same as pages/folders already do.)
    const c = await api(t, 'POST', '/ycode/api/layer-styles', { name: `Canary Style ${Date.now()}`, classes: 'text-red-500' });
    recordApi(area, 'create layer style', c, [200, 201]);
    if (c.json?.data?.id) created.layerStyleId = c.json.data.id;
  }

  {
    const c = await api(t, 'POST', '/ycode/api/color-variables', { name: 'canaryColor', value: '#123456' });
    recordApi(area, 'create color variable', c, [200, 201]);
    if (c.json?.data?.id) created.colorVarId = c.json.data.id;
  }
  if (created.colorVarId) {
    recordApi(area, 'update color variable', await api(t, 'PUT', `/ycode/api/color-variables/${created.colorVarId}`, { value: '#654321' }), [200]);
  }

  {
    // Code must be unique per run: locales has a UNIQUE index on
    // (tenant_id, code, is_published) that does NOT exclude soft-deleted rows
    // — same latent quirk as layer_styles (see the comment above). code is
    // varchar(10), no ISO-format check constraint, so a short unique suffix fits.
    const c = await api(t, 'POST', '/ycode/api/locales', { code: `t${Date.now().toString().slice(-6)}`, label: 'Canary Locale' });
    recordApi(area, 'create locale', c, [200, 201]);
    if (c.json?.data?.locale?.id) created.localeId = c.json.data.locale.id;
  }

  {
    const c = await api(t, 'POST', '/ycode/api/asset-folders', { name: 'Canary Asset Folder' });
    recordApi(area, 'create asset folder', c, [200, 201]);
    if (c.json?.data?.id) created.assetFolderId = c.json.data.id;
  }
  {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10"/></svg>';
    const c = await api(t, 'POST', '/ycode/api/assets', { filename: 'canary.svg', content: svg, asset_folder_id: created.assetFolderId });
    recordApi(area, 'create asset (svg)', c, [200, 201]);
    if (c.json?.data?.id) created.assetId = c.json.data.id;
  }
  recordApi(area, 'list assets', await api(t, 'GET', '/ycode/api/assets'), [200]);

  recordApi(area, 'update setting', await api(t, 'PUT', '/ycode/api/settings/site_name', { value: 'Canary Site Name' }), [200]);

  {
    const c = await api(t, 'POST', '/ycode/api/globals', { name: 'canaryGlobal', type: 'text', value: 'hello' });
    recordApi(area, 'create global variable', c, [200, 201]);
    if (c.json?.data?.id) created.globalId = c.json.data.id;
  }

  recordApi(area, 'editor init (aggregate read)', await api(t, 'GET', '/ycode/api/editor/init'), [200]);
}

async function keysAndTokens(t: Tenant, created: Record<string, string>) {
  const area = `${t.label}:keys`;

  const ak = await api(t, 'POST', '/ycode/api/api-keys', { name: 'Canary Key' });
  recordApi(area, 'create api key', ak, [200, 201]);
  if (ak.json?.data?.id) created.apiKeyId = ak.json.data.id;
  recordApi(area, 'list api keys', await api(t, 'GET', '/ycode/api/api-keys'), [200]);

  const mt = await api(t, 'POST', '/ycode/api/mcp-tokens', { name: 'Canary MCP Token' });
  recordApi(area, 'create mcp token', mt, [200, 201]);
  if (mt.json?.data?.id) created.mcpTokenId = mt.json.data.id;
  const mtToken = mt.json?.data?.token;

  if (mtToken) {
    const mcpRes = await fetch(`https://${t.host}/ycode/mcp/${mtToken}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'canary', version: '1' } } }),
    });
    record(area, 'MCP token authenticates + initializes', mcpRes.status === 200, mcpRes.status, mcpRes.status === 200 ? undefined : await mcpRes.text().catch(() => undefined));
  }

  const wh = await api(t, 'POST', '/ycode/api/webhooks', { name: 'Canary Webhook', url: 'https://example.com/webhook-canary', events: ['page.published'] });
  recordApi(area, 'create webhook', wh, [200, 201]);
  if (wh.json?.data?.id) created.webhookId = wh.json.data.id;
}

async function authAndUsers(t: Tenant) {
  const area = `${t.label}:auth`;
  const list = await api(t, 'GET', '/ycode/api/auth/users');
  const ok = list.status === 200 && Array.isArray(list.json?.data?.activeUsers) && list.json.data.activeUsers.length >= 1;
  record(area, 'list users (owner present)', ok, list.status, ok ? undefined : JSON.stringify(list.json)?.slice(0, 300));

  recordApi(area, 'update own profile name', await api(t, 'PUT', '/ycode/api/profile/name', { name: `${t.label}-canary` }), [200]);
  recordApi(area, 'revert own profile name', await api(t, 'PUT', '/ycode/api/profile/name', { name: t.label }), [200]);
}

async function publishFlow(t: Tenant) {
  const area = `${t.label}:publish`;
  recordApi(area, 'publish preview', await api(t, 'GET', '/ycode/api/publish/preview'), [200]);
  recordApi(area, 'publish', await api(t, 'POST', '/ycode/api/publish'), [200]);
}

async function crossTenantChecks(attacker: Tenant, victim: Tenant, victimIds: Record<string, string>, victimSnapshot: Record<string, string>) {
  const area = `${attacker.label}:cross-tenant-vs-${victim.label}`;

  type Attempt = { method: string; path: string; label: string; body?: unknown; verify?: { path: string; field: string; expected: string } };
  const attempts: Attempt[] = [
    { method: 'GET', path: `/ycode/api/pages/${victimIds.pageId}`, label: 'read victim page' },
    { method: 'PUT', path: `/ycode/api/pages/${victimIds.pageId}`, label: 'write victim page', body: { name: 'HACKED' }, verify: { path: `/ycode/api/pages/${victimIds.pageId}`, field: 'data.name', expected: victimSnapshot.pageName } },
    { method: 'DELETE', path: `/ycode/api/pages/${victimIds.pageId}`, label: 'delete victim page', verify: { path: `/ycode/api/pages/${victimIds.pageId}`, field: 'data.deleted_at', expected: 'null' } },
    { method: 'GET', path: `/ycode/api/collections/${victimIds.collectionId}`, label: 'read victim collection' },
    { method: 'PUT', path: `/ycode/api/collections/${victimIds.collectionId}`, label: 'write victim collection', body: { name: 'HACKED' }, verify: { path: `/ycode/api/collections/${victimIds.collectionId}`, field: 'data.name', expected: victimSnapshot.collectionName } },
    { method: 'GET', path: `/ycode/api/collections/${victimIds.collectionId}/items/${victimIds.itemId}`, label: 'read victim collection item' },
    { method: 'PUT', path: `/ycode/api/collections/${victimIds.collectionId}/items/${victimIds.itemId}`, label: 'write victim collection item', body: { is_publishable: false }, verify: { path: `/ycode/api/collections/${victimIds.collectionId}/items/${victimIds.itemId}`, field: 'data.is_publishable', expected: 'true' } },
    { method: 'GET', path: `/ycode/api/components/${victimIds.componentId}`, label: 'read victim component' },
    { method: 'GET', path: `/ycode/api/assets/${victimIds.assetId}`, label: 'read victim asset' },
    { method: 'DELETE', path: `/ycode/api/assets/${victimIds.assetId}`, label: 'delete victim asset', verify: { path: `/ycode/api/assets/${victimIds.assetId}`, field: 'data.deleted_at', expected: 'null' } },
    { method: 'GET', path: `/ycode/api/api-keys/${victimIds.apiKeyId}`, label: 'read victim api key' },
    { method: 'DELETE', path: `/ycode/api/mcp-tokens/${victimIds.mcpTokenId}`, label: 'delete victim mcp token', verify: { path: `/ycode/api/mcp-tokens`, field: 'includesId', expected: victimIds.mcpTokenId } },
    { method: 'GET', path: `/ycode/api/color-variables`, label: 'list own color-variables (must not include victim)' },
  ];

  for (const a of attempts) {
    if (a.path.includes('undefined')) {
      record(area, a.label, false, undefined, 'SKIPPED — victim id missing');
      continue;
    }
    const r = await api(attacker, a.method, a.path, a.body);
    const text = JSON.stringify(r.json ?? r.text);
    let ok: boolean;
    let detail: string;

    if (a.verify) {
      const v = await api(victim, 'GET', a.verify.path);
      if (a.verify.field === 'includesId') {
        ok = JSON.stringify(v.json).includes(a.verify.expected);
        detail = ok ? 'victim resource intact' : 'VICTIM RESOURCE ACTUALLY DELETED — real leak';
      } else {
        let val: any = v.json;
        for (const p of a.verify.field.split('.')) val = val?.[p];
        const actual = val === null ? 'null' : String(val);
        ok = actual === a.verify.expected;
        detail = ok ? `victim data unchanged (verified)` : `VICTIM DATA ACTUALLY CHANGED (${a.verify.field}=${actual}, expected ${a.verify.expected}) — real leak`;
      }
    } else {
      const leaked = r.status === 200 && Object.values(victimIds).some((v) => v && text.includes(v));
      ok = !leaked;
      detail = ok ? `no victim data present` : 'RESPONSE CONTAINS VICTIM DATA — real leak';
    }
    record(area, `${a.label} (${a.method} ${a.path})`, ok, r.status, detail);
  }

  const crossHost = await fetch(`https://${victim.host}/ycode/api/auth/users`, { headers: { Cookie: attacker.cookie } });
  const crossHostText = await crossHost.text();
  const leaked = crossHost.status === 200 && crossHostText.includes(victim.tenantId) && !crossHostText.includes(attacker.tenantId);
  record(area, `cross-host: attacker cookie sent to ${victim.host}`, crossHost.status !== 200 || !leaked, crossHost.status);
}

async function cleanup(t: Tenant, created: Record<string, string>) {
  const area = `${t.label}:cleanup`;
  const del = async (path: string, label: string) => {
    try {
      const r = await api(t, 'DELETE', path);
      record(area, `delete ${label}`, r.status === 200 || r.status === 204 || r.status === 404, r.status);
    } catch (e) {
      record(area, `delete ${label}`, false, undefined, e instanceof Error ? e.message : String(e));
    }
  };
  if (created.itemId && created.collectionId) await del(`/ycode/api/collections/${created.collectionId}/items/${created.itemId}`, 'collection item');
  if (created.fieldId && created.collectionId) await del(`/ycode/api/collections/${created.collectionId}/fields/${created.fieldId}`, 'collection field');
  if (created.collectionId) await del(`/ycode/api/collections/${created.collectionId}`, 'collection');
  if (created.componentId) await del(`/ycode/api/components/${created.componentId}`, 'component');
  if (created.layerStyleId) await del(`/ycode/api/layer-styles/${created.layerStyleId}`, 'layer style');
  if (created.colorVarId) await del(`/ycode/api/color-variables/${created.colorVarId}`, 'color variable');
  if (created.localeId) await del(`/ycode/api/locales/${created.localeId}`, 'locale');
  if (created.assetId) await del(`/ycode/api/assets/${created.assetId}`, 'asset');
  if (created.assetFolderId) await del(`/ycode/api/asset-folders/${created.assetFolderId}`, 'asset folder');
  if (created.globalId) await del(`/ycode/api/globals/${created.globalId}`, 'global variable');
  if (created.apiKeyId) await del(`/ycode/api/api-keys/${created.apiKeyId}`, 'api key');
  if (created.mcpTokenId) await del(`/ycode/api/mcp-tokens/${created.mcpTokenId}`, 'mcp token');
  if (created.webhookId) await del(`/ycode/api/webhooks/${created.webhookId}`, 'webhook');
  if (created.pageIdDup) await del(`/ycode/api/pages/${created.pageIdDup}`, 'duplicated page');
  if (created.pageId) await del(`/ycode/api/pages/${created.pageId}`, 'page');
  if (created.pageFolderId) await del(`/ycode/api/folders/${created.pageFolderId}`, 'page folder');
}

async function main() {
  const startedAt = Date.now();
  const A: Tenant = { label: CANARIES.A.label, host: CANARIES.A.host, tenantId: CANARIES.A.tenantId, cookie: '' };
  const B: Tenant = { label: CANARIES.B.label, host: CANARIES.B.host, tenantId: CANARIES.B.tenantId, cookie: '' };

  try {
    console.log('=== login ===');
    A.cookie = (await resetPasswordAndLogin(A.host, CANARIES.A.userId, CANARIES.A.email)).cookie;
    B.cookie = (await resetPasswordAndLogin(B.host, CANARIES.B.userId, CANARIES.B.email)).cookie;
    record('setup', 'login both canary tenants', !!A.cookie && !!B.cookie);

    console.log('=== content CRUD ===');
    await contentCrud(A, createdA);
    await contentCrud(B, createdB);

    console.log('=== auth/users ===');
    await authAndUsers(A);
    await authAndUsers(B);

    console.log('=== keys/tokens/webhooks ===');
    await keysAndTokens(A, createdA);
    await keysAndTokens(B, createdB);

    console.log('=== publish ===');
    await publishFlow(A);
    await publishFlow(B);

    console.log('=== cross-tenant boundary checks ===');
    async function snapshot(t: Tenant, ids: Record<string, string>): Promise<Record<string, string>> {
      const page = await api(t, 'GET', `/ycode/api/pages/${ids.pageId}`);
      const coll = await api(t, 'GET', `/ycode/api/collections/${ids.collectionId}`);
      return { pageName: page.json?.data?.name ?? '', collectionName: coll.json?.data?.name ?? '' };
    }
    const snapB = await snapshot(B, createdB);
    const snapA = await snapshot(A, createdA);
    await crossTenantChecks(A, B, createdB, snapB);
    await crossTenantChecks(B, A, createdA, snapA);
  } catch (e) {
    record('fatal', 'unhandled exception during test run', false, undefined, e instanceof Error ? `${e.message}\n${e.stack}` : String(e));
  } finally {
    console.log('=== cleanup (always runs) ===');
    try {
      if (A.cookie) await cleanup(A, createdA);
    } catch (e) {
      record('high900:cleanup', 'cleanup threw', false, undefined, e instanceof Error ? e.message : String(e));
    }
    try {
      if (B.cookie) await cleanup(B, createdB);
    } catch (e) {
      record('assasx7:cleanup', 'cleanup threw', false, undefined, e instanceof Error ? e.message : String(e));
    }
  }

  const durationMs = Date.now() - startedAt;
  const fails = results.filter((r) => !r.ok);
  const summary = fails.length === 0
    ? `All ${results.length} live isolation checks passed (canaries: ${A.label}, ${B.label}).`
    : `${fails.length}/${results.length} live isolation checks FAILED: ${fails.slice(0, 5).map((f) => `${f.area}::${f.step}`).join('; ')}${fails.length > 5 ? '…' : ''}`;
  const failureOutput = fails.length
    ? fails.map((f) => `FAIL ${f.area} :: ${f.step}${f.status ? ` (${f.status})` : ''} — ${f.detail || ''}`).join('\n')
    : '';

  console.log(`\n=== SUMMARY: ${results.length - fails.length}/${results.length} passed in ${durationMs}ms ===`);
  if (fails.length) console.log(failureOutput);

  writeFileSync(process.env.RESULTS_JSON_PATH || 'tenant-isolation-live-check-results.json', JSON.stringify({
    status: fails.length === 0 ? 'pass' : 'fail',
    durationMs,
    summary,
    failureOutput,
    totalChecks: results.length,
    failedChecks: fails.length,
    results,
  }, null, 2));

  process.exit(fails.length === 0 ? 0 : 1);
}

main();
