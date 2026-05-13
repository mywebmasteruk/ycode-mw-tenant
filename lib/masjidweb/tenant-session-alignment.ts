import type { User } from '@supabase/supabase-js';

/**
 * Returns true if JWT tenant claim and request tenant header refer to the same tenant.
 * Used to align RLS expectations (JWT user_metadata.tenant_id) with proxy-injected x-tenant-id.
 */
export function normalizeTenantId(value: string): string {
  return value.trim().toLowerCase();
}

/**
 * When both the Supabase JWT carries tenant_id and the request has x-tenant-id (set only by
 * proxy from host → tenant_registry or from JWT on apex /ycode), they must match or the client
 * is attempting to use a session for a different tenant than the host claims.
 *
 * @returns null if aligned or if either side is missing (backward compatibility)
 * @returns error message key if mismatched
 */
export function tenantJwtHeaderMismatchReason(
  headerTenantId: string | null | undefined,
  user: User,
): 'tenant_mismatch' | null {
  const fromJwt = user.app_metadata?.tenant_id || user.user_metadata?.tenant_id;
  if (typeof fromJwt !== 'string' || !fromJwt.trim()) {
    return null;
  }
  const header = headerTenantId?.trim() ?? '';
  if (!header) {
    return null;
  }
  if (normalizeTenantId(fromJwt) !== normalizeTenantId(header)) {
    return 'tenant_mismatch';
  }
  return null;
}
