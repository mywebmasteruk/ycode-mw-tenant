import { describe, expect, it, vi } from 'vitest';
import type { User } from '@supabase/supabase-js';
import {
  bootstrapTenantOwnerIfNeeded,
  isPendingTenantInvite,
  tenantHasOwnerOrAdmin,
} from './bootstrap-tenant-owner';

function tenantUser(
  id: string,
  options: {
    tenantId?: string;
    role?: string;
    invited?: boolean;
    signedIn?: boolean;
  } = {},
): User {
  const {
    tenantId = 'tenant-a',
    role,
    invited = false,
    signedIn = true,
  } = options;

  return {
    id,
    email: `${id}@example.com`,
    created_at: '2026-01-01T00:00:00.000Z',
    last_sign_in_at: signedIn ? '2026-01-02T00:00:00.000Z' : null,
    email_confirmed_at: signedIn ? '2026-01-02T00:00:00.000Z' : null,
    identities: signedIn ? [{ id: 'identity-1' }] : [],
    app_metadata: {
      tenant_id: tenantId,
      ...(role ? { role } : {}),
      ...(invited ? { invited_at: '2026-01-01T00:00:00.000Z' } : {}),
    },
    user_metadata: { tenant_id: tenantId },
    aud: 'authenticated',
  } as User;
}

describe('bootstrap tenant owner', () => {
  it('detects pending invites', () => {
    const pending = tenantUser('pending', { invited: true, signedIn: false });
    expect(isPendingTenantInvite(pending)).toBe(true);
    expect(isPendingTenantInvite(tenantUser('active'))).toBe(false);
  });

  it('detects existing owner or admin', () => {
    const users = [
      tenantUser('owner-user', { role: 'owner' }),
      tenantUser('designer-user', { role: 'designer' }),
    ];
    expect(tenantHasOwnerOrAdmin(users)).toBe(true);
    expect(tenantHasOwnerOrAdmin([tenantUser('designer-user', { role: 'designer' })])).toBe(false);
  });

  it('promotes the current active user when tenant has no owner/admin', async () => {
    const users = [tenantUser('admin-candidate', { role: 'designer' })];
    const updateUserById = vi.fn().mockResolvedValue({ error: null });
    const client = {
      auth: {
        admin: {
          updateUserById,
        },
      },
    } as never;

    const promoted = await bootstrapTenantOwnerIfNeeded(
      client,
      'tenant-a',
      'admin-candidate',
      users,
    );

    expect(promoted).toBe(true);
    expect(updateUserById).toHaveBeenCalledWith('admin-candidate', {
      app_metadata: expect.objectContaining({
        tenant_id: 'tenant-a',
        role: 'owner',
      }),
    });
  });

  it('does not promote when tenant already has an admin', async () => {
    const users = [
      tenantUser('existing-admin', { role: 'admin' }),
      tenantUser('designer-user', { role: 'designer' }),
    ];
    const updateUserById = vi.fn();
    const client = {
      auth: {
        admin: {
          updateUserById,
        },
      },
    } as never;

    const promoted = await bootstrapTenantOwnerIfNeeded(
      client,
      'tenant-a',
      'designer-user',
      users,
    );

    expect(promoted).toBe(false);
    expect(updateUserById).not.toHaveBeenCalled();
  });
});
