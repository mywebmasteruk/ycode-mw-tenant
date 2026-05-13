import type { User } from '@supabase/supabase-js';
import { normalizeTenantId } from '@/lib/masjidweb/tenant-session-alignment';

type TenantScopedAuthUser = Pick<User, 'id' | 'email' | 'created_at' | 'last_sign_in_at' | 'identities' | 'app_metadata' | 'user_metadata'> & {
  raw_app_meta_data?: Record<string, unknown>;
  raw_user_meta_data?: Record<string, unknown>;
};

export function authUserTenantId(user: TenantScopedAuthUser): string | null {
  const appMetadata = user.app_metadata || user.raw_app_meta_data || {};
  const userMetadata = user.user_metadata || user.raw_user_meta_data || {};
  const tenantId = appMetadata.tenant_id || userMetadata.tenant_id;
  return typeof tenantId === 'string' && tenantId.trim()
    ? normalizeTenantId(tenantId)
    : null;
}

export function authUserBelongsToTenant(
  user: TenantScopedAuthUser,
  tenantId: string | null | undefined,
): boolean {
  const expected = tenantId?.trim();
  if (!expected) return false;
  return authUserTenantId(user) === normalizeTenantId(expected);
}

export function filterAuthUsersForTenant<T extends TenantScopedAuthUser>(
  users: T[],
  tenantId: string | null | undefined,
): T[] {
  return users.filter((user) => authUserBelongsToTenant(user, tenantId));
}
