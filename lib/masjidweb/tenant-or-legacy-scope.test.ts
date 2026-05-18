import { describe, expect, it, vi } from 'vitest';
import { applyTenantOrLegacyScope } from './tenant-or-legacy-scope';

describe('applyTenantOrLegacyScope', () => {
  it('allows current-tenant rows and legacy unscoped rows when a tenant is known', () => {
    const query = {
      or: vi.fn().mockReturnThis(),
    };

    const result = applyTenantOrLegacyScope(query, 'tenant-1');

    expect(result).toBe(query);
    expect(query.or).toHaveBeenCalledWith('tenant_id.eq.tenant-1,tenant_id.is.null');
  });

  it('uses a custom tenant column when records are indirectly scoped', () => {
    const query = {
      or: vi.fn().mockReturnThis(),
    };

    applyTenantOrLegacyScope(query, 'tenant-1', 'owner_tenant_id');

    expect(query.or).toHaveBeenCalledWith('owner_tenant_id.eq.tenant-1,owner_tenant_id.is.null');
  });

  it('leaves the query unchanged when tenant context is unavailable', () => {
    const query = {
      or: vi.fn().mockReturnThis(),
    };

    const result = applyTenantOrLegacyScope(query, null);

    expect(result).toBe(query);
    expect(query.or).not.toHaveBeenCalled();
  });
});
