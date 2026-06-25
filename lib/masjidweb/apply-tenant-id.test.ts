import { describe, expect, it } from 'vitest';
import { applyTenantId } from './apply-tenant-id';

describe('applyTenantId', () => {
  it('stamps tenant_id onto a single object payload', () => {
    expect(applyTenantId({ name: 'a' }, 't1')).toEqual({ name: 'a', tenant_id: 't1' });
  });

  it('stamps tenant_id onto every object in an array payload', () => {
    expect(applyTenantId([{ id: 1 }, { id: 2 }], 't1')).toEqual([
      { id: 1, tenant_id: 't1' },
      { id: 2, tenant_id: 't1' },
    ]);
  });

  it('returns the payload unchanged when tenantId is missing', () => {
    const p = { name: 'a' };
    expect(applyTenantId(p, null)).toBe(p);
    expect(applyTenantId(p, undefined)).toBe(p);
    expect(applyTenantId(p, '')).toBe(p);
  });

  it('is idempotent: re-stamps to the current tenant instead of duplicating', () => {
    expect(applyTenantId({ name: 'a', tenant_id: 'old' }, 't2')).toEqual({ name: 'a', tenant_id: 't2' });
  });

  it('passes non-object array elements through untouched', () => {
    expect(applyTenantId(['x', { id: 1 }], 't1')).toEqual(['x', { id: 1, tenant_id: 't1' }]);
  });
});
