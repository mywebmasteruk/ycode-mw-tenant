import type { SupabaseClient, User } from '@supabase/supabase-js';
import { filterAuthUsersForTenant } from '@/lib/masjidweb/auth-users-tenant-scope';

function readAppMetadata(user: User): Record<string, unknown> {
  const userAny = user as User & { raw_app_meta_data?: Record<string, unknown> };
  return user.app_metadata || userAny.raw_app_meta_data || {};
}

function readUserMetadata(user: User): Record<string, unknown> {
  const userAny = user as User & { raw_user_meta_data?: Record<string, unknown> };
  return user.user_metadata || userAny.raw_user_meta_data || {};
}

export function isPendingTenantInvite(user: User): boolean {
  const metadata = { ...readUserMetadata(user), ...readAppMetadata(user) };
  const wasInvited = !!metadata.invited_at;
  const hasIdentities = user.identities && user.identities.length > 0;
  const hasSignedIn = user.last_sign_in_at !== null;
  const emailConfirmed = !!user.email_confirmed_at;
  return wasInvited && !emailConfirmed && !hasIdentities && !hasSignedIn;
}

export function tenantHasOwnerOrAdmin(users: User[]): boolean {
  return users.some((user) => {
    const role = readAppMetadata(user).role;
    return role === 'owner' || role === 'admin';
  });
}

/**
 * MasjidWeb tenants are provisioned without a Ycode role. After the core RBAC
 * update, invite/member management requires owner or admin. Promote the current
 * active user when their tenant has no owner/admin yet (typical tenant admin).
 */
export async function bootstrapTenantOwnerIfNeeded(
  client: SupabaseClient,
  tenantId: string,
  currentUserId: string | undefined,
  tenantUsers?: User[],
): Promise<boolean> {
  if (!currentUserId) return false;

  let users = tenantUsers;
  if (!users) {
    const { data, error } = await client.auth.admin.listUsers({
      page: 1,
      perPage: 1000,
    });
    if (error || !data?.users) return false;
    users = filterAuthUsersForTenant(data.users, tenantId);
  }

  if (tenantHasOwnerOrAdmin(users)) return false;

  const currentUser = users.find((user) => user.id === currentUserId);
  if (!currentUser || isPendingTenantInvite(currentUser)) return false;

  const { error } = await client.auth.admin.updateUserById(currentUserId, {
    app_metadata: {
      ...readAppMetadata(currentUser),
      role: 'owner',
    },
  });

  if (error) {
    console.error('[bootstrap-tenant-owner] Failed to assign owner role:', error);
    return false;
  }

  return true;
}
