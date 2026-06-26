/**
 * Pure write-payload helper — the insert/upsert analogue of applyTenantEq.
 *
 * Stamps `tenant_id` onto a write payload the codemod can't reach as an inline
 * object literal (a pre-built array, a mapped variable, a function result). Used
 * as `client.from(t).upsert(applyTenantId(rows, tenantId))`. Pure + dependency-
 * free so it is safe to import from client tests.
 *
 * - object  → { ...payload, tenant_id }
 * - array   → each object element gets tenant_id (non-objects pass through)
 * - no tenantId → payload returned unchanged (mirrors applyTenantEq)
 * Idempotent: re-stamps to the current tenant rather than duplicating.
 */
export function applyTenantId<T>(payload: T, tenantId: string | null | undefined): T {
  if (!tenantId) return payload;
  if (Array.isArray(payload)) {
    return payload.map((row) =>
      row && typeof row === 'object' && !Array.isArray(row) ? { ...row, tenant_id: tenantId } : row,
    ) as T;
  }
  if (payload && typeof payload === 'object') {
    return { ...(payload as Record<string, unknown>), tenant_id: tenantId } as T;
  }
  return payload;
}
