import { NextRequest } from 'next/server';
import { getSupabaseAdmin } from '@/lib/supabase-server';
import { noCache } from '@/lib/api-response';
import {
  authUserBelongsToTenant,
  filterAuthUsersForTenant,
} from '@/lib/masjidweb/auth-users-tenant-scope';

/**
 * GET /ycode/api/auth/users
 *
 * List all users with their status (active or pending invite)
 */
export async function GET(request: NextRequest) {
  try {
    const tenantId = request.headers.get('x-tenant-id')?.trim();

    if (!tenantId) {
      return noCache(
        { error: 'Tenant context is required' },
        403
      );
    }

    const client = await getSupabaseAdmin();

    if (!client) {
      return noCache(
        { error: 'Supabase not configured' },
        500
      );
    }

    const { data, error } = await client.auth.admin.listUsers({
      page: 1,
      perPage: 1000,
    });

    if (error) {
      console.error('[users] Error listing users:', error);
      return noCache(
        { error: error.message },
        500
      );
    }

    const activeUsers: Array<{
      id: string;
      email: string;
      display_name: string | null;
      avatar_url: string | null;
      created_at: string;
      last_sign_in_at: string | null;
    }> = [];

    const pendingInvites: Array<{
      id: string;
      email: string;
      invited_at: string;
    }> = [];

    for (const user of filterAuthUsersForTenant(data.users, tenantId)) {
      const userAny = user as any;
      const appMetadata = user.app_metadata || userAny.raw_app_meta_data || {};
      const userMetadata = user.user_metadata || userAny.raw_user_meta_data || {};
      const metadata = { ...userMetadata, ...appMetadata };
      const wasInvited = !!metadata.invited_at;
      const hasIdentities = user.identities && user.identities.length > 0;
      const hasSignedIn = user.last_sign_in_at !== null;
      const isPending = wasInvited && (!hasSignedIn || !hasIdentities);

      if (!isPending) {
        activeUsers.push({
          id: user.id,
          email: user.email || '',
          display_name: metadata.display_name || metadata.full_name || null,
          avatar_url: metadata.avatar_url || null,
          created_at: user.created_at,
          last_sign_in_at: user.last_sign_in_at || null,
        });
      } else {
        pendingInvites.push({
          id: user.id,
          email: user.email || '',
          invited_at: String(metadata.invited_at || user.created_at),
        });
      }
    }

    return noCache({
      data: {
        activeUsers,
        pendingInvites,
      },
    });
  } catch (error) {
    console.error('[users] Unexpected error:', error);
    return noCache(
      { error: 'Failed to fetch users' },
      500
    );
  }
}

/**
 * DELETE /ycode/api/auth/users
 *
 * Delete a user or cancel a pending invite
 */
export async function DELETE(request: NextRequest) {
  try {
    const tenantId = request.headers.get('x-tenant-id')?.trim();

    if (!tenantId) {
      return noCache(
        { error: 'Tenant context is required' },
        403
      );
    }

    const { searchParams } = new URL(request.url);
    const userId = searchParams.get('id');

    if (!userId) {
      return noCache(
        { error: 'User ID is required' },
        400
      );
    }

    const client = await getSupabaseAdmin();

    if (!client) {
      return noCache(
        { error: 'Supabase not configured' },
        500
      );
    }

    const { data: targetUser, error: getUserError } = await client.auth.admin.getUserById(userId);

    if (getUserError) {
      console.error('[users] Error finding user:', getUserError);
      return noCache(
        { error: getUserError.message },
        400
      );
    }

    if (!targetUser.user || !authUserBelongsToTenant(targetUser.user, tenantId)) {
      return noCache(
        { error: 'User not found for this tenant' },
        404
      );
    }

    const { error } = await client.auth.admin.deleteUser(userId);

    if (error) {
      console.error('[users] Error deleting user:', error);
      return noCache(
        { error: error.message },
        400
      );
    }

    return noCache({
      data: { success: true },
    });
  } catch (error) {
    console.error('[users] Unexpected error:', error);
    return noCache(
      { error: 'Failed to delete user' },
      500
    );
  }
}
