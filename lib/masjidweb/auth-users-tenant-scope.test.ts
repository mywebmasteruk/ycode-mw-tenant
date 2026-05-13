import { describe, expect, it } from 'vitest';
import type { User } from '@supabase/supabase-js';
import {
  authUserBelongsToTenant,
  authUserTenantId,
  filterAuthUsersForTenant,
} from './auth-users-tenant-scope';

function user(id: string, tenantId?: string): User {
  return {
    id,
    email: `${id}@example.com`,
    created_at: '2026-01-01T00:00:00.000Z',
    last_sign_in_at: null,
    app_metadata: tenantId ? { tenant_id: tenantId } : {},
    user_metadata: {},
    aud: 'authenticated',
  } as User;
}

describe('auth users tenant scoping', () => {
  it('normalizes tenant metadata before comparing', () => {
    const u = user('u1', '  ABC  ');
    expect(authUserTenantId(u)).toBe('abc');
    expect(authUserBelongsToTenant(u, 'abc')).toBe(true);
  });

  it('falls back to legacy user metadata when app metadata has not been backfilled', () => {
    const u = {
      ...user('legacy'),
      user_metadata: { tenant_id: 'tenant-a' },
    } as User;

    expect(authUserBelongsToTenant(u, 'tenant-a')).toBe(true);
  });

  it('excludes users with missing or different tenant metadata', () => {
    const users = [
      user('tenant-a-user', 'tenant-a'),
      user('tenant-b-user', 'tenant-b'),
      user('unassigned'),
    ];

    expect(filterAuthUsersForTenant(users, 'tenant-a').map((u) => u.id)).toEqual([
      'tenant-a-user',
    ]);
  });

  it('returns no users when current tenant is missing', () => {
    expect(filterAuthUsersForTenant([user('u1', 'tenant-a')], null)).toEqual([]);
  });
});
