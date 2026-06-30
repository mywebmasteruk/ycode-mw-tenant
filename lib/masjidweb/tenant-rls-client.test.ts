import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@/lib/masjidweb/effective-tenant-id', () => ({
  resolveEffectiveTenantId: vi.fn(),
}));

import { tenantRlsEnforceEnabled, maybeGetTenantScopedClient } from './tenant-rls-client';
import { resolveEffectiveTenantId } from '@/lib/masjidweb/effective-tenant-id';

const fetchStub = (() => Promise.resolve(new Response())) as unknown as typeof globalThis.fetch;

// These guard the rollback-safety contract: OFF must be a no-op, and ON must fail SAFE
// (fall back to service_role by returning null) when it can't mint a tenant token.
describe('tenant-rls-client safety contract', () => {
  const ORIGINAL = process.env;
  beforeEach(() => {
    vi.clearAllMocks();
    process.env = { ...ORIGINAL };
  });
  afterEach(() => {
    process.env = ORIGINAL;
  });

  it('flag unset → enforcement OFF and returns null without resolving a tenant (true no-op)', async () => {
    delete process.env.MW_TENANT_RLS_ENFORCE;
    expect(tenantRlsEnforceEnabled()).toBe(false);
    const client = await maybeGetTenantScopedClient('https://x.supabase.co', 'anon', fetchStub);
    expect(client).toBeNull();
    expect(resolveEffectiveTenantId).not.toHaveBeenCalled();
  });

  it('flag set to non-true value → OFF', () => {
    process.env.MW_TENANT_RLS_ENFORCE = 'false';
    expect(tenantRlsEnforceEnabled()).toBe(false);
    process.env.MW_TENANT_RLS_ENFORCE = '1';
    expect(tenantRlsEnforceEnabled()).toBe(false);
  });

  it('flag ON but signing key missing → fail-safe null (service_role fallback)', async () => {
    process.env.MW_TENANT_RLS_ENFORCE = 'true';
    delete process.env.MW_TENANT_JWT_PRIVATE_JWK;
    (resolveEffectiveTenantId as ReturnType<typeof vi.fn>).mockResolvedValue(
      '11111111-1111-1111-1111-111111111111',
    );
    const client = await maybeGetTenantScopedClient('https://x.supabase.co', 'anon', fetchStub);
    expect(client).toBeNull();
  });

  it('flag ON but no tenant in context → fail-safe null', async () => {
    process.env.MW_TENANT_RLS_ENFORCE = 'true';
    (resolveEffectiveTenantId as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    const client = await maybeGetTenantScopedClient('https://x.supabase.co', 'anon', fetchStub);
    expect(client).toBeNull();
  });
});
