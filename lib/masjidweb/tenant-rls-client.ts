// MASJIDWEB_SEAM: tenant-rls-enforcement — see docs/masjidweb-core-seams.md#tier-1
/**
 * Flag-gated tenant-scoped Supabase client (Phase 4 RLS enforcement).
 *
 * The app normally queries with the service_role key, which BYPASSES RLS; tenant
 * isolation is enforced in app code (`applyTenantEq`) + the Phase 3 gate. This module
 * optionally upgrades the app to also be enforced by the DATABASE: when enabled, it
 * mints a short-lived tenant-scoped JWT (role=authenticated, user_metadata.tenant_id)
 * with a BYOK ES256 signing key and returns a supabase-js client carrying it, so RLS
 * filters every query to the effective tenant.
 *
 * SAFETY / ROLLBACK:
 * - Controlled by env `MW_TENANT_RLS_ENFORCE`. Default OFF → this returns null and the
 *   caller uses the unchanged service_role client (zero behaviour change). Rollback is
 *   flipping the flag back to anything but 'true' and redeploying.
 * - Even when ON, this is FAIL-SAFE: any problem (no tenant context, missing/invalid
 *   signing key, mint error) returns null → caller falls back to service_role. So
 *   enabling can only ADD isolation; a minting failure never breaks the builder.
 *   (RLS policy correctness is validated separately on non-prod before enabling.)
 *
 * Validated end-to-end on the non-prod project 2026-06-30 (see TENANT-ISOLATION-AND-CLONE-PLAN.md).
 */
import crypto from 'node:crypto';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { resolveEffectiveTenantId } from '@/lib/masjidweb/effective-tenant-id';
import { supabaseServerRealtimeOptions } from '@/lib/supabase-server-options';

const TOKEN_TTL_SECONDS = 600; // 10 min; clients re-minted ~1 min before expiry

/** Only the literal 'true' enables enforcement; anything else (unset/false) = OFF. */
export function tenantRlsEnforceEnabled(): boolean {
  // Never enforce at build time (generateStaticParams etc. run with no tenant request
  // context) — keep build-time DB reads on service-role.
  if (process.env.NEXT_PHASE === 'phase-production-build') return false;
  return process.env.MW_TENANT_RLS_ENFORCE === 'true';
}

let warned = false;
function warnOnce(reason: string): void {
  if (warned) return;
  warned = true;
  console.warn(`[tenant-rls] enforcement ON but falling back to service_role: ${reason}`);
}

function loadSigningKey(): { key: crypto.KeyObject; kid: string } | null {
  const jwkStr = process.env.MW_TENANT_JWT_PRIVATE_JWK;
  if (!jwkStr) return null;
  try {
    const jwk = JSON.parse(jwkStr) as crypto.JsonWebKey & { kid?: string };
    const kid = jwk.kid || process.env.MW_TENANT_JWT_KID;
    if (!kid) return null;
    const key = crypto.createPrivateKey({ key: jwk, format: 'jwk' });
    return { key, kid };
  } catch {
    return null;
  }
}

const b64url = (b: Buffer | string): string =>
  Buffer.from(b).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');

function mintTenantJwt(tenantId: string, key: crypto.KeyObject, kid: string, now: number): string {
  const header = { alg: 'ES256', typ: 'JWT', kid };
  const payload = {
    role: 'authenticated',
    aud: 'authenticated',
    sub: tenantId, // valid UUID so policies calling auth.uid() don't error
    iat: now,
    exp: now + TOKEN_TTL_SECONDS,
    // Most RLS policies read user_metadata.tenant_id (current_tenant_id()/jwt_tenant_id()),
    // but api_keys and form_submissions read app_metadata.tenant_id directly — the same two
    // locations a real provisioned user's JWT carries (see
    // masjidweb-backend/admin-dashboard-v2/src/lib/provision-auth-metadata.ts). Found by the
    // 2026-07-01 exhaustive API test: api_keys writes failed RLS because only user_metadata
    // was set here. Set both so every policy shape resolves the tenant correctly.
    app_metadata: { tenant_id: tenantId },
    user_metadata: { tenant_id: tenantId },
  };
  const signingInput = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
  // ES256 JWTs need the raw R||S signature (JOSE), not DER — hence dsaEncoding.
  const sig = crypto.sign('sha256', Buffer.from(signingInput), { key, dsaEncoding: 'ieee-p1363' });
  return `${signingInput}.${b64url(sig)}`;
}

const clientCache = new Map<string, { client: SupabaseClient; exp: number }>();

/**
 * Returns a tenant-scoped (RLS-enforced) supabase-js client, or null to signal the caller
 * to use the service_role client. Never throws.
 */
export async function maybeGetTenantScopedClient(
  projectUrl: string,
  anonKey: string,
  limitedFetch: typeof globalThis.fetch,
): Promise<SupabaseClient | null> {
  if (!tenantRlsEnforceEnabled()) return null;
  try {
    const tenantId = await resolveEffectiveTenantId();
    if (!tenantId) {
      warnOnce('no effective tenant id in context');
      return null;
    }
    const signing = loadSigningKey();
    if (!signing) {
      warnOnce('MW_TENANT_JWT_PRIVATE_JWK missing or invalid');
      return null;
    }

    const now = Math.floor(Date.now() / 1000);
    const cached = clientCache.get(tenantId);
    if (cached && cached.exp - 60 > now) return cached.client;

    const jwt = mintTenantJwt(tenantId, signing.key, signing.kid, now);
    const client = createClient(projectUrl, anonKey, {
      auth: { autoRefreshToken: false, persistSession: false },
      realtime: supabaseServerRealtimeOptions,
      global: { fetch: limitedFetch, headers: { Authorization: `Bearer ${jwt}` } },
    });
    clientCache.set(tenantId, { client, exp: now + TOKEN_TTL_SECONDS });
    return client;
  } catch (error) {
    console.warn('[tenant-rls] mint/build failed, using service_role:', error instanceof Error ? error.message : error);
    return null;
  }
}
