import { afterEach, describe, expect, it, vi } from 'vitest';
import { applyTenantEq, MW_RLS_ENFORCED_HEADER } from '@/lib/masjidweb/apply-tenant-eq';

type ChainedEq = { eq: (c: string, v: string) => ChainedEq; headers?: unknown };

describe('applyTenantEq', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('chains eq when tenantId set', () => {
    const q: ChainedEq = {
      eq: vi.fn((c: string, v: string) => q),
    };
    const out = applyTenantEq(q, 'tid');
    expect(q.eq).toHaveBeenCalledWith('tenant_id', 'tid');
    expect(out).toBe(q);
  });

  it('returns same object when tenantId null', () => {
    const q: ChainedEq = {
      eq: vi.fn((c: string, v: string) => q),
    };
    const out = applyTenantEq(q, null);
    expect(q.eq).not.toHaveBeenCalled();
    expect(out).toBe(q);
  });

  describe('seam retirement (MW_SEAMS_RETIRED)', () => {
    const rlsMarkedQuery = (): ChainedEq => {
      const q: ChainedEq = {
        eq: vi.fn((c: string, v: string) => q),
        headers: new Headers({ [MW_RLS_ENFORCED_HEADER]: '1' }),
      };
      return q;
    };

    it('flag ON + RLS marker (Headers instance) → skips the app-layer filter', () => {
      vi.stubEnv('MW_SEAMS_RETIRED', 'true');
      const q = rlsMarkedQuery();
      const out = applyTenantEq(q, 'tid');
      expect(q.eq).not.toHaveBeenCalled();
      expect(out).toBe(q);
    });

    it('flag ON + RLS marker (plain object headers) → skips the app-layer filter', () => {
      vi.stubEnv('MW_SEAMS_RETIRED', 'true');
      const q: ChainedEq = {
        eq: vi.fn((c: string, v: string) => q),
        headers: { [MW_RLS_ENFORCED_HEADER]: '1' },
      };
      const out = applyTenantEq(q, 'tid');
      expect(q.eq).not.toHaveBeenCalled();
      expect(out).toBe(q);
    });

    it('flag ON but NO marker (service-role fallback shape) → still filters', () => {
      vi.stubEnv('MW_SEAMS_RETIRED', 'true');
      const q: ChainedEq = {
        eq: vi.fn((c: string, v: string) => q),
        headers: new Headers({ authorization: 'Bearer service-role' }),
      };
      applyTenantEq(q, 'tid');
      expect(q.eq).toHaveBeenCalledWith('tenant_id', 'tid');
    });

    it('flag ON but query has no headers at all → still filters', () => {
      vi.stubEnv('MW_SEAMS_RETIRED', 'true');
      const q: ChainedEq = {
        eq: vi.fn((c: string, v: string) => q),
      };
      applyTenantEq(q, 'tid');
      expect(q.eq).toHaveBeenCalledWith('tenant_id', 'tid');
    });

    it('flag OFF (default) → filters even when the RLS marker is present', () => {
      const q = rlsMarkedQuery();
      applyTenantEq(q, 'tid');
      expect(q.eq).toHaveBeenCalledWith('tenant_id', 'tid');
    });

    it('flag set to anything but literal true → filters', () => {
      vi.stubEnv('MW_SEAMS_RETIRED', '1');
      const q = rlsMarkedQuery();
      applyTenantEq(q, 'tid');
      expect(q.eq).toHaveBeenCalledWith('tenant_id', 'tid');
    });
  });
});
