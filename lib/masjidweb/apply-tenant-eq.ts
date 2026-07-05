/**
 * Pure PostgREST helper — safe to import from client tests without pulling server-only repos.
 */

type TenantEqQuery = {
  eq: (column: string, value: string) => unknown;
};

// MASJIDWEB_SEAM: seam-retirement — RLS-only experiment (MW_SEAMS_RETIRED).
/**
 * Header the RLS-enforced tenant client stamps on all its requests (via supabase-js
 * global headers; postgrest-js copies client headers onto every query builder).
 */
export const MW_RLS_ENFORCED_HEADER = 'x-mw-rls-enforced';

/** Only the literal 'true' retires the app-layer filter; anything else = seams active. */
export function seamRetirementEnabled(): boolean {
  return typeof process !== 'undefined' && process.env.MW_SEAMS_RETIRED === 'true';
}

/**
 * True only when the query was provably built by the RLS-enforced tenant client
 * (lib/masjidweb/tenant-rls-client.ts stamps MW_RLS_ENFORCED_HEADER on it). The
 * service-role fallback and build-time clients never carry the marker, so any doubt
 * keeps the filter — bypass requires positive proof that Postgres RLS scopes the query.
 */
function queryIsRlsEnforced(query: unknown): boolean {
  const headers = (query as { headers?: unknown }).headers;
  if (!headers) return false;
  if (typeof (headers as Headers).get === 'function') {
    return (headers as Headers).get(MW_RLS_ENFORCED_HEADER) === '1';
  }
  return (headers as Record<string, string>)[MW_RLS_ENFORCED_HEADER] === '1';
}

export function applyTenantEq<Q>(query: Q, tenantId: string | null | undefined): Q {
  if (tenantId) {
    if (seamRetirementEnabled() && queryIsRlsEnforced(query)) {
      return query;
    }
    return (query as TenantEqQuery).eq('tenant_id', tenantId) as Q;
  }
  return query;
}
// MASJIDWEB_SEAM_END
