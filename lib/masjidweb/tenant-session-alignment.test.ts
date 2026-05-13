/**
 * Security unit tests aligned with `proxy.ts` behaviour for `/ycode/api/*`:
 * when both `x-tenant-id` (proxy-injected) and JWT `user_metadata.tenant_id` exist,
 * they must match. Full HTTP integration tests would run against `next dev` + fetch;
 * these cover the same predicate without a live server.
 */
import { describe, expect, it } from 'vitest';
import type { User } from '@supabase/supabase-js';
import {
  normalizeTenantId,
  tenantJwtHeaderMismatchReason,
} from '@/lib/masjidweb/tenant-session-alignment';

function userWithTenant(tenantId: string): User {
  return {
    id: 'u1',
    app_metadata: {},
    user_metadata: { tenant_id: tenantId },
    aud: 'authenticated',
    created_at: '',
  } as User;
}

describe('normalizeTenantId', () => {
  it('trims and lowercases', () => {
    expect(normalizeTenantId('  ABC  ')).toBe('abc');
  });
});

describe('tenantJwtHeaderMismatchReason', () => {
  it('returns null when JWT has no tenant_id', () => {
    const u = {
      id: 'u1',
      app_metadata: {},
      user_metadata: {},
      aud: 'authenticated',
      created_at: '',
    } as User;
    expect(tenantJwtHeaderMismatchReason('11111111-1111-1111-1111-111111111111', u)).toBeNull();
  });

  it('returns null when header is empty', () => {
    expect(tenantJwtHeaderMismatchReason('', userWithTenant('aa'))).toBeNull();
    expect(tenantJwtHeaderMismatchReason(null, userWithTenant('aa'))).toBeNull();
  });

  it('prefers app metadata tenant over legacy user metadata', () => {
    const u = {
      ...userWithTenant('legacy-tenant'),
      app_metadata: { tenant_id: 'app-tenant' },
    } as User;

    expect(tenantJwtHeaderMismatchReason('app-tenant', u)).toBeNull();
    expect(tenantJwtHeaderMismatchReason('legacy-tenant', u)).toBe('tenant_mismatch');
  });

  it('returns null when both match (case-insensitive)', () => {
    const id = '2FFF887D-A78E-4256-9116-6E02FE38C614';
    expect(
      tenantJwtHeaderMismatchReason(id.toLowerCase(), userWithTenant(id.toUpperCase())),
    ).toBeNull();
  });

  it('returns tenant_mismatch when both set and differ', () => {
    expect(
      tenantJwtHeaderMismatchReason('11111111-1111-1111-1111-111111111111', userWithTenant('22222222-2222-2222-2222-222222222222')),
    ).toBe('tenant_mismatch');
  });
});
