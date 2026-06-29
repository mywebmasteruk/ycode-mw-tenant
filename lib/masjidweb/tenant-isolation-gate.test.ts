import { describe, expect, it } from 'vitest';
import {
  analyzeTenantIsolation,
  isolationRegressions,
  TENANT_SCOPED_TABLES,
} from './tenant-isolation-gate';

const scopedRead = `
import { applyTenantEq } from '@/lib/masjidweb/apply-tenant-eq';
export async function getSettings(client, tenantId) {
  let query = client.from('settings').select('*').order('key');
  query = applyTenantEq(query, tenantId);
  return query;
}
`;

const unscopedRead = `
export async function getSettings(client) {
  const { data } = await client.from('settings').select('*');
  return data;
}
`;

const scopedWrite = `
export async function saveSetting(client, tenantId, key, value) {
  const row = { key, value, ...(tenantId ? { tenant_id: tenantId } : {}) };
  return client.from('settings').upsert(row, { onConflict: 'tenant_id,key' });
}
`;

const unscopedWrite = `
export async function saveSetting(client, key, value) {
  return client.from('settings').upsert({ key, value });
}
`;

describe('analyzeTenantIsolation', () => {
  it('passes a tenant-scoped read (applyTenantEq)', () => {
    expect(analyzeTenantIsolation('settingsRepository.ts', scopedRead)).toEqual([]);
  });

  it('flags an unscoped read on a tenant table', () => {
    const findings = analyzeTenantIsolation('settingsRepository.ts', unscopedRead);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ table: 'settings', op: 'read' });
  });

  it('passes a tenant-scoped write (tenant_id in payload)', () => {
    expect(analyzeTenantIsolation('settingsRepository.ts', scopedWrite)).toEqual([]);
  });

  it('flags an upsert with no tenant_id in the payload', () => {
    const findings = analyzeTenantIsolation('settingsRepository.ts', unscopedWrite);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ table: 'settings', op: 'write' });
  });

  it('passes a literal .eq(tenant_id) scope', () => {
    const src = `export async function f(client, t) {
      return client.from('pages').select('*').eq('tenant_id', t);
    }`;
    expect(analyzeTenantIsolation('pageRepository.ts', src)).toEqual([]);
  });

  it('ignores non-tenant tables', () => {
    const src = `export async function f(client) {
      return client.from('migrations').select('*');
    }`;
    expect(analyzeTenantIsolation('x.ts', src)).toEqual([]);
  });

  it('honors the isolation-ok escape hatch on the line above', () => {
    const src = `export async function f(client) {
      // isolation-ok: platform-wide locale catalog, not tenant data
      return client.from('locales').select('*');
    }`;
    expect(analyzeTenantIsolation('x.ts', src)).toEqual([]);
  });

  it('flags only the unscoped query when a function mixes scoped and unscoped (per-variable)', () => {
    const src = `export async function f(client, t) {
      let a = client.from('pages').select('*');
      a = applyTenantEq(a, t);
      const b = await client.from('assets').select('*');
      return [a, b];
    }`;
    const findings = analyzeTenantIsolation('x.ts', src);
    // 'a' is scoped via applyTenantEq(a, …); 'b' is an unscoped inline read → exactly one finding.
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ table: 'assets', op: 'read' });
  });

  it('canonical tenant table set includes the core CMS tables', () => {
    for (const t of ['pages', 'collection_items', 'page_layers', 'settings', 'assets']) {
      expect(TENANT_SCOPED_TABLES.has(t)).toBe(true);
    }
  });
});

describe('isolationRegressions (differential gate)', () => {
  const baseline = `export async function f(client) {
    // isolation-ok: platform-wide content-hash backfill
    return client.from('pages').select('*').is('content_hash', null);
  }`;
  // Same legitimately-global query, still annotated → no regression.
  const unchanged = baseline;
  // A merge dropped the applyTenantEq scope from a previously-scoped read.
  const baselineScoped = `export async function g(client, t) {
    let q = client.from('pages').select('*');
    q = applyTenantEq(q, t);
    return q;
  }`;
  const droppedScope = `export async function g(client, t) {
    return client.from('pages').select('*');
  }`;

  it('passes when the file is unchanged (pre-existing global pattern baselined out)', () => {
    const base = analyzeTenantIsolation('pageRepository.ts', baseline);
    const merged = analyzeTenantIsolation('pageRepository.ts', unchanged);
    expect(isolationRegressions(base, merged)).toEqual([]);
  });

  it('fails when a merge drops a previously-present tenant scope', () => {
    const base = analyzeTenantIsolation('pageRepository.ts', baselineScoped);
    const merged = analyzeTenantIsolation('pageRepository.ts', droppedScope);
    const regressions = isolationRegressions(base, merged);
    expect(regressions).toHaveLength(1);
    expect(regressions[0]).toMatchObject({ fn: 'g', table: 'pages', op: 'read' });
  });

  it('does not flag a pre-existing unscoped access that was already in baseline', () => {
    // Same already-unscoped read in both → not a regression (baseline accepts it).
    const src = `export async function h(client) { return client.from('pages').select('*'); }`;
    const base = analyzeTenantIsolation('pageRepository.ts', src);
    const merged = analyzeTenantIsolation('pageRepository.ts', src);
    expect(isolationRegressions(base, merged)).toEqual([]);
  });
});

describe('tenant table set', () => {
  it('includes the core CMS tables (sanity)', () => {
    for (const t of ['pages', 'collection_items', 'page_layers', 'settings', 'assets']) {
      expect(TENANT_SCOPED_TABLES.has(t)).toBe(true);
    }
  });
});

describe('recognized scope mechanisms (beyond applyTenantEq)', () => {
  it('treats applyTenantOrLegacyScope(query, tid) as scoped — inline and assigned', () => {
    const inline = `async function f(t){ const c={}; const {data}=await applyTenantOrLegacyScope(c.from('api_keys').select('*'), t); return data; }`;
    const assigned = `async function f(t){ const c={}; let q=c.from('api_keys').select('*'); q=applyTenantOrLegacyScope(q,t); return await q; }`;
    expect(analyzeTenantIsolation('apiKeyRepository.ts', inline)).toEqual([]);
    expect(analyzeTenantIsolation('apiKeyRepository.ts', assigned)).toEqual([]);
  });

  it("recognizes a supabase-js chain carrying a literal .where('tenant_id') as scoped", () => {
    const src = `async function f(t){ const c={}; const {data}=await c.from('translations').select('*').where('tenant_id', t); return data; }`;
    expect(analyzeTenantIsolation('translationRepository.ts', src)).toEqual([]);
  });

  it("does NOT analyze the Knex knex('table') entrypoint (no .from()) — known limitation, covered file-level by the autopilot guard", () => {
    // A bare, totally-unscoped Knex query yields 0 findings because the analyzer
    // only sees `<expr>.from('<table>')`, not `knex('<table>')`. Documents the gap.
    const bareKnex = `async function f(){ const knex=()=>{}; return await knex('translations').select('*'); }`;
    expect(analyzeTenantIsolation('translationRepository.ts', bareKnex)).toEqual([]);
  });

  it('treats scopeCollectionItemTimestampUpdate(query, itemId, tid) as scoped', () => {
    const src = `async function f(t,id){ const c={}; const q=c.from('collection_items').update({}); await scopeCollectionItemTimestampUpdate(q,id,t); }`;
    expect(analyzeTenantIsolation('route.ts', src)).toEqual([]);
  });

  it('FLAGS a tenant-table chain passed in a non-first argument to a scope helper', () => {
    const src = `async function f(t){ const c={}; const other={}; return await applyTenantOrLegacyScope(other, c.from('api_keys').select('*')); }`;
    expect(analyzeTenantIsolation('apiKeyRepository.ts', src)).toHaveLength(1);
  });

  it('a commented-out scope call does NOT satisfy the assigned-var evidence', () => {
    const src = `async function f(t){ const c={};\n  // applyTenantEq(q, t)\n  let q=c.from('api_keys').select('*'); return await q; }`;
    expect(analyzeTenantIsolation('apiKeyRepository.ts', src)).toHaveLength(1);
  });

  it('a suffix-named non-helper (xapplyTenantEq) does NOT count as scoping', () => {
    const src = `async function f(t){ const c={}; let q=c.from('api_keys').select('*'); q=xapplyTenantEq(q,t); return await q; }`;
    expect(analyzeTenantIsolation('apiKeyRepository.ts', src)).toHaveLength(1);
  });

  it('still flags a genuinely bare tenant-table read', () => {
    const src = `async function f(){ const c={}; const {data}=await c.from('versions').select('*'); return data; }`;
    expect(analyzeTenantIsolation('versionRepository.ts', src)).toHaveLength(1);
  });
});
