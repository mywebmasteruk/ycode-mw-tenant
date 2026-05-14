import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  resolveEffectiveTenantId: vi.fn(),
  getSupabaseAdmin: vi.fn(),
}));

vi.mock('@/lib/masjidweb/effective-tenant-id', () => ({
  resolveEffectiveTenantId: mocks.resolveEffectiveTenantId,
}));

vi.mock('@/lib/supabase-server', () => ({
  getSupabaseAdmin: mocks.getSupabaseAdmin,
}));

import { getUpdateTenantContext } from './update-tenant-access';

function supabaseWithTenantResult(result: {
  data: { id: string; slug: string; tenant_kind: 'template' | 'client' } | null;
  error: { message: string } | null;
}) {
  const maybeSingle = vi.fn().mockResolvedValue(result);
  const eq = vi.fn(() => ({ maybeSingle }));
  const select = vi.fn(() => ({ eq }));
  const from = vi.fn(() => ({ select }));

  return {
    client: { from },
    from,
    select,
    eq,
    maybeSingle,
  };
}

describe('getUpdateTenantContext', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('marks tenant_registry template tenants as allowed to see updates', async () => {
    mocks.resolveEffectiveTenantId.mockResolvedValue('tenant-template');
    const supabase = supabaseWithTenantResult({
      data: { id: 'tenant-template', slug: 'template-demo', tenant_kind: 'template' },
      error: null,
    });
    mocks.getSupabaseAdmin.mockResolvedValue(supabase.client);

    await expect(getUpdateTenantContext()).resolves.toEqual({
      tenantId: 'tenant-template',
      slug: 'template-demo',
      tenantKind: 'template',
      isTemplateTenant: true,
    });
    expect(supabase.from).toHaveBeenCalledWith('tenant_registry');
    expect(supabase.eq).toHaveBeenCalledWith('id', 'tenant-template');
  });

  it('fails closed for client tenants', async () => {
    mocks.resolveEffectiveTenantId.mockResolvedValue('tenant-client');
    const supabase = supabaseWithTenantResult({
      data: { id: 'tenant-client', slug: 'client-demo', tenant_kind: 'client' },
      error: null,
    });
    mocks.getSupabaseAdmin.mockResolvedValue(supabase.client);

    await expect(getUpdateTenantContext()).resolves.toMatchObject({
      tenantId: 'tenant-client',
      slug: 'client-demo',
      tenantKind: 'client',
      isTemplateTenant: false,
    });
  });

  it('fails closed when no trusted tenant id is available', async () => {
    mocks.resolveEffectiveTenantId.mockResolvedValue(null);

    await expect(getUpdateTenantContext()).resolves.toEqual({
      tenantId: null,
      slug: null,
      tenantKind: null,
      isTemplateTenant: false,
    });
    expect(mocks.getSupabaseAdmin).not.toHaveBeenCalled();
  });

  it('fails closed when the tenant lookup errors', async () => {
    mocks.resolveEffectiveTenantId.mockResolvedValue('tenant-error');
    const supabase = supabaseWithTenantResult({
      data: null,
      error: { message: 'database unavailable' },
    });
    mocks.getSupabaseAdmin.mockResolvedValue(supabase.client);

    await expect(getUpdateTenantContext()).resolves.toEqual({
      tenantId: 'tenant-error',
      slug: null,
      tenantKind: null,
      isTemplateTenant: false,
    });
  });
});
