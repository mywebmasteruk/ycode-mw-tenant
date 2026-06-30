import { AsyncLocalStorage } from 'async_hooks';

import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { resolveEffectiveTenantId } from '@/lib/masjidweb/effective-tenant-id';
import { credentials } from './credentials';
import { parseSupabaseConfig } from './supabase-config-parser';
import type { SupabaseConfig, SupabaseCredentials } from '@/types';
import { withLimit } from './supabase-limiter';
import { supabaseServerRealtimeOptions } from './supabase-server-options';
// MASJIDWEB_SEAM: tenant-rls-enforcement — see docs/masjidweb-core-seams.md#tier-1
import { maybeGetTenantScopedClient, tenantRlsEnforceEnabled } from '@/lib/masjidweb/tenant-rls-client';
// MASJIDWEB_SEAM_END

/**
 * Supabase Server Client
 *
 * Creates authenticated Supabase clients for server-side operations
 * Credentials are fetched from file-based storage or environment variables
 */

/**
 * Explicit tenant context for code running outside of a Next.js request
 * (e.g. fire-and-forget webhook processing where headers() is unavailable).
 */
export const tenantStore = new AsyncLocalStorage<string>();

/** Run an async function with an explicit tenant context. */
export function runWithTenantId<T>(tenantId: string, fn: () => Promise<T>): Promise<T> {
  return tenantStore.run(tenantId, fn);
}

/**
 * Get Supabase credentials from storage
 * Parses the stored config to extract all necessary details
 */
async function getSupabaseCredentials(): Promise<SupabaseCredentials | null> {
  const config = await credentials.get<SupabaseConfig>('supabase_config');

  if (!config) {
    return null;
  }

  try {
    return parseSupabaseConfig(config);
  } catch (error) {
    console.error('[getSupabaseCredentials] Failed to parse config:', error);
    return null;
  }
}

/**
 * Get Supabase configuration (exported for use in knex-client)
 * Alias for getSupabaseCredentials
 */
export const getSupabaseConfig = getSupabaseCredentials;

const globalForSupabase = globalThis as unknown as {
  __supabaseClient?: SupabaseClient;
  __supabaseCredKey?: string;
};

let loggedMissingAdminCreds = false;

/**
 * Get Supabase client with service role key (admin access).
 * Tenant scoping is done in queries (e.g. `resolveEffectiveTenantId`), not on the client.
 *
 * Stored on globalThis so the client survives Next.js HMR in dev mode.
 * Module-level variables get reset on each hot reload, which would
 * orphan any in-flight requests on the old client.
 */
/**
 * Always-service-role client (admin access, bypasses RLS). Use for operations that
 * genuinely need service-role and must NOT be tenant-scoped: GoTrue admin API
 * (`auth.admin.*`), global / cross-tenant tables (tenant_registry, mcp_oauth_*, the
 * mcp_tokens auth lookup), `exec_sql`, and bucket-level storage admin. Unaffected by
 * MW_TENANT_RLS_ENFORCE — this is the pre-flag behaviour of getSupabaseAdmin.
 */
export async function getSupabaseServiceRole(): Promise<SupabaseClient | null> {
  const creds = await getSupabaseCredentials();

  if (!creds) {
    const duringNextBuild = process.env.NEXT_PHASE === 'phase-production-build';
    if (!duringNextBuild && !loggedMissingAdminCreds) {
      loggedMissingAdminCreds = true;
      console.warn(
        '[getSupabaseServiceRole] No stored Supabase credentials yet (complete setup in /ycode or configure storage).',
      );
    }
    return null;
  }

  const credKey = `${creds.projectUrl}:${creds.serviceRoleKey}`;
  if (globalForSupabase.__supabaseClient && globalForSupabase.__supabaseCredKey === credKey) {
    return globalForSupabase.__supabaseClient;
  }

  const limitedFetch: typeof globalThis.fetch = (input, init) =>
    withLimit(() => globalThis.fetch(input, init));

  globalForSupabase.__supabaseClient = createClient(creds.projectUrl, creds.serviceRoleKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
    realtime: supabaseServerRealtimeOptions,
    global: { fetch: limitedFetch },
  });

  globalForSupabase.__supabaseCredKey = credKey;

  return globalForSupabase.__supabaseClient;
}

/**
 * Default client for TENANT-DATA access. With MW_TENANT_RLS_ENFORCE on, returns a
 * per-tenant RLS-enforced client (falling back to service-role on any mint problem);
 * otherwise the service-role client. Admin/privileged/cross-tenant callers must use
 * {@link getSupabaseServiceRole} — those break under a tenant-scoped client.
 */
export async function getSupabaseAdmin(_tenantId?: string): Promise<SupabaseClient | null> {
  // MASJIDWEB_SEAM: tenant-rls-enforcement — flag-gated (MW_TENANT_RLS_ENFORCE).
  // OFF (default) → service-role (getSupabaseServiceRole), unchanged behaviour.
  // ON → per-tenant RLS client; returns null (→ service-role fallback) on any problem.
  // Rollback = unset the flag + redeploy. See lib/masjidweb/tenant-rls-client.ts.
  if (tenantRlsEnforceEnabled()) {
    const creds = await getSupabaseCredentials();
    if (creds) {
      const tenantFetch: typeof globalThis.fetch = (input, init) =>
        withLimit(() => globalThis.fetch(input, init));
      const tenantClient = await maybeGetTenantScopedClient(creds.projectUrl, creds.anonKey, tenantFetch);
      if (tenantClient) return tenantClient;
    }
  }
  // MASJIDWEB_SEAM_END

  return getSupabaseServiceRole();
}

/**
 * Test Supabase connection with full config
 */
export async function testSupabaseConnection(
  config: SupabaseConfig
): Promise<{ success: boolean; error?: string }> {
  try {
    const parsed = parseSupabaseConfig(config);

    const client = createClient(parsed.projectUrl, parsed.serviceRoleKey, {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
      },
      realtime: supabaseServerRealtimeOptions,
    });

    const { error } = await client.auth.admin.listUsers({
      page: 1,
      perPage: 1,
    });

    if (error) {
      console.error('[testSupabaseConnection] Failed:', { url: parsed.projectUrl, error: error.message, status: error.status });
      return { success: false, error: error.message };
    }

    return { success: true };
  } catch (error) {
    console.error('[testSupabaseConnection] Failed:', error);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Connection failed',
    };
  }
}

/**
 * Delegates to `resolveEffectiveTenantId` — kept as the name Knex helpers use.
 */
export async function getTenantIdFromHeaders(): Promise<string | null> {
  return resolveEffectiveTenantId();
}

/**
 * Execute raw SQL query
 */
export async function executeSql(sql: string): Promise<{ success: boolean; error?: string }> {
  // Service-role: exec_sql is a privileged RPC; a tenant-scoped client can't run it.
  const client = await getSupabaseServiceRole();

  if (!client) {
    return { success: false, error: 'Supabase not configured' };
  }

  try {
    const { error } = await client.rpc('exec_sql', { sql });

    if (error) {
      return { success: false, error: error.message };
    }

    return { success: true };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'SQL execution failed',
    };
  }
}
