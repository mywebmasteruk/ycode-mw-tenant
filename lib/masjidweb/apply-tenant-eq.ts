/**
 * Pure PostgREST helper — safe to import from client tests without pulling server-only repos.
 */

type TenantEqQuery = {
  eq: (column: string, value: string) => unknown;
};

export function applyTenantEq<Q>(query: Q, tenantId: string | null | undefined): Q {
  if (tenantId) {
    return (query as TenantEqQuery).eq('tenant_id', tenantId) as Q;
  }
  return query;
}
