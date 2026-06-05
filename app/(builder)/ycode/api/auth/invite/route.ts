import { NextRequest } from 'next/server';
import { resolveInviteRedirectUrl } from '@/lib/auth-invite-redirect';
import { getSupabaseAdmin } from '@/lib/supabase-server';
import { noCache } from '@/lib/api-response';
import { requireManageMembers } from '@/lib/roles-server';
import { ASSIGNABLE_ROLES } from '@/lib/roles';

/**
 * POST /ycode/api/auth/invite
 *
 * Invite a user by email using Supabase's built-in invite system.
 * Requires owner or admin role.
 */
export async function POST(request: NextRequest) {
  try {
    const result = await requireManageMembers();
    if ('status' in result) return result;

    const tenantId = request.headers.get('x-tenant-id')?.trim();
    const tenantSlug = request.headers.get('x-tenant-slug')?.trim();

    if (!tenantId) {
      return noCache(
        { error: 'Tenant context is required' },
        403
      );
    }

    const body = await request.json();
    const { email, role = 'designer', redirectTo } = body;

    if (!email) {
      return noCache({ error: 'Email is required' }, 400);
    }

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      return noCache({ error: 'Invalid email format' }, 400);
    }

    const assignRole = ASSIGNABLE_ROLES.includes(role) ? role : 'designer';

    const client = await getSupabaseAdmin();
    if (!client) {
      return noCache({ error: 'Supabase not configured' }, 500);
    }

    const redirect = resolveInviteRedirectUrl(request, redirectTo);

    const invitedAt = new Date().toISOString();
    const { data, error } = await client.auth.admin.inviteUserByEmail(email, {
      redirectTo: redirect,
      data: {
        invited_at: invitedAt,
        tenant_id: tenantId,
        ...(tenantSlug ? { tenant_slug: tenantSlug } : {}),
      },
    });

    if (error) {
      console.error('[invite] Error inviting user:', error);
      return noCache({ error: error.message }, 400);
    }

    if (data.user) {
      await client.auth.admin.updateUserById(data.user.id, {
        app_metadata: { role: assignRole },
      });
    }

    if (data.user?.id) {
      const { error: updateError } = await client.auth.admin.updateUserById(
        data.user.id,
        {
          app_metadata: {
            ...(data.user.app_metadata || {}),
            tenant_id: tenantId,
            ...(tenantSlug ? { tenant_slug: tenantSlug } : {}),
          },
          user_metadata: {
            ...(data.user.user_metadata || {}),
            invited_at: data.user.user_metadata?.invited_at || invitedAt,
            tenant_id: tenantId,
            ...(tenantSlug ? { tenant_slug: tenantSlug } : {}),
          },
        },
      );

      if (updateError) {
        console.error('[invite] Error tagging invited user with tenant metadata:', updateError);
        return noCache(
          { error: updateError.message },
          500
        );
      }
    }

    return noCache({
      data: {
        user: data.user,
        role: assignRole,
        message: `Invitation sent to ${email}`,
      },
    });
  } catch (error) {
    console.error('[invite] Unexpected error:', error);
    return noCache(
      { error: 'Failed to send invitation' },
      500
    );
  }
}
