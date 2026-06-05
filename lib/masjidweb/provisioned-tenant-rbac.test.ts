/**
 * Regression tests: provisioned tenant admin RBAC
 *
 * MasjidWeb tenants are provisioned without a Ycode `role` in app_metadata.
 * After the core RBAC update (commit 8176908 / merge feafbe0), invite and
 * member-management routes require owner or admin. Without bootstrapping,
 * provisioned tenants silently lost the ability to invite users.
 *
 * These tests guard the invariants that prevented that regression from being
 * caught before deploy:
 *   1. A role-less user resolves to designer (the default).
 *   2. A designer cannot manage members (invite hidden).
 *   3. bootstrapTenantOwnerIfNeeded promotes the only active user to owner.
 *   4. After bootstrap the same user can manage members.
 *   5. Bootstrap is a no-op when a tenant already has an owner/admin.
 *   6. A pending invite (unconfirmed) user is not promoted.
 */

import { describe, expect, it, vi } from 'vitest';
import type { User } from '@supabase/supabase-js';
import { resolveRole, canManageMembers } from '@/lib/roles';
import {
  bootstrapTenantOwnerIfNeeded,
  tenantHasOwnerOrAdmin,
  isPendingTenantInvite,
} from '@/lib/masjidweb/bootstrap-tenant-owner';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeUser(
  id: string,
  opts: {
    tenantId?: string;
    role?: string;
    invited?: boolean;
    signedIn?: boolean;
  } = {},
): User {
  const { tenantId = 'tenant-a', role, invited = false, signedIn = true } = opts;
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

function makeAdminClient(updateResult: { error: null | { message: string } } = { error: null }) {
  const updateUserById = vi.fn().mockResolvedValue(updateResult);
  const listUsers = vi.fn().mockResolvedValue({ data: { users: [] }, error: null });
  return {
    auth: { admin: { updateUserById, listUsers } },
    updateUserById,
    listUsers,
  };
}

// ---------------------------------------------------------------------------
// 1. Role resolution — no role defaults to designer
// ---------------------------------------------------------------------------
describe('role resolution for provisioned tenant', () => {
  it('resolves undefined role to designer', () => {
    expect(resolveRole(undefined)).toBe('designer');
  });

  it('resolves null role to designer', () => {
    expect(resolveRole(null)).toBe('designer');
  });

  it('resolves empty-string role to designer', () => {
    expect(resolveRole('')).toBe('designer');
  });

  it('resolves "owner" correctly', () => {
    expect(resolveRole('owner')).toBe('owner');
  });

  it('resolves "admin" correctly', () => {
    expect(resolveRole('admin')).toBe('admin');
  });
});

// ---------------------------------------------------------------------------
// 2. Permission check — designer cannot manage members
// ---------------------------------------------------------------------------
describe('canManageMembers for provisioned-default role', () => {
  it('designer cannot manage members (invite hidden)', () => {
    expect(canManageMembers('designer')).toBe(false);
  });

  it('editor cannot manage members', () => {
    expect(canManageMembers('editor')).toBe(false);
  });

  it('owner can manage members', () => {
    expect(canManageMembers('owner')).toBe(true);
  });

  it('admin can manage members', () => {
    expect(canManageMembers('admin')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 3-4. Bootstrap: promote role-less user to owner
// ---------------------------------------------------------------------------
describe('bootstrapTenantOwnerIfNeeded', () => {
  it('promotes the only active user when tenant has no owner/admin', async () => {
    const user = makeUser('admin-candidate', { role: 'designer' });
    const client = makeAdminClient();

    const promoted = await bootstrapTenantOwnerIfNeeded(
      client as any,
      'tenant-a',
      'admin-candidate',
      [user],
    );

    expect(promoted).toBe(true);
    expect(client.updateUserById).toHaveBeenCalledWith('admin-candidate', {
      app_metadata: expect.objectContaining({ role: 'owner' }),
    });
  });

  it('is a no-op when an owner already exists', async () => {
    const owner = makeUser('existing-owner', { role: 'owner' });
    const candidate = makeUser('other-user', { role: 'designer' });
    const client = makeAdminClient();

    const promoted = await bootstrapTenantOwnerIfNeeded(
      client as any,
      'tenant-a',
      'other-user',
      [owner, candidate],
    );

    expect(promoted).toBe(false);
    expect(client.updateUserById).not.toHaveBeenCalled();
  });

  it('is a no-op when an admin already exists', async () => {
    const admin = makeUser('existing-admin', { role: 'admin' });
    const client = makeAdminClient();

    const promoted = await bootstrapTenantOwnerIfNeeded(
      client as any,
      'tenant-a',
      'existing-admin',
      [admin],
    );

    expect(promoted).toBe(false);
    expect(client.updateUserById).not.toHaveBeenCalled();
  });

  it('does not promote a pending invite (unconfirmed user)', async () => {
    const pending = makeUser('pending-invite', { invited: true, signedIn: false });
    const client = makeAdminClient();

    const promoted = await bootstrapTenantOwnerIfNeeded(
      client as any,
      'tenant-a',
      'pending-invite',
      [pending],
    );

    expect(promoted).toBe(false);
    expect(client.updateUserById).not.toHaveBeenCalled();
  });

  it('returns false when no currentUserId provided', async () => {
    const user = makeUser('admin-candidate');
    const client = makeAdminClient();

    const promoted = await bootstrapTenantOwnerIfNeeded(
      client as any,
      'tenant-a',
      undefined,
      [user],
    );

    expect(promoted).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 5. Full invariant: provisioned user can manage members after bootstrap
// ---------------------------------------------------------------------------
describe('end-to-end: provisioned tenant admin gets invite access', () => {
  it('designer cannot manage members before bootstrap', () => {
    // Simulates the state when a tenant admin first logs in after core update
    const provisionedRole = resolveRole(undefined); // no role in app_metadata
    expect(canManageMembers(provisionedRole)).toBe(false);
  });

  it('can manage members after bootstrap assigns owner', () => {
    // Simulates state after bootstrapTenantOwnerIfNeeded runs
    const roleAfterBootstrap = resolveRole('owner');
    expect(canManageMembers(roleAfterBootstrap)).toBe(true);
  });

  it('tenantHasOwnerOrAdmin returns false for designer-only tenant', () => {
    const users = [makeUser('u1', { role: 'designer' }), makeUser('u2', { role: 'editor' })];
    expect(tenantHasOwnerOrAdmin(users)).toBe(false);
  });

  it('tenantHasOwnerOrAdmin returns true once bootstrap completes', () => {
    // After bootstrap the user in the DB has role: owner
    const users = [makeUser('u1', { role: 'owner' }), makeUser('u2', { role: 'designer' })];
    expect(tenantHasOwnerOrAdmin(users)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 6. isPendingTenantInvite guard
// ---------------------------------------------------------------------------
describe('isPendingTenantInvite', () => {
  it('identifies pending (invited, not confirmed)', () => {
    expect(isPendingTenantInvite(makeUser('p', { invited: true, signedIn: false }))).toBe(true);
  });

  it('active user is not pending', () => {
    expect(isPendingTenantInvite(makeUser('a'))).toBe(false);
  });
});
