import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/tenant/middleware-utils', () => ({
  getSupabaseEnvConfig: vi.fn(() => ({
    url: 'https://example.supabase.co',
    anonKey: 'anon',
  })),
}));

import {
  clearTenantLookupCacheForTests,
  lookupTenant,
} from './tenant-registry-lookup';

describe('lookupTenant cache', () => {
  beforeEach(() => {
    clearTenantLookupCacheForTests();
    delete process.env.TENANT_LOOKUP_CACHE_SUCCESS_MS;
    delete process.env.TENANT_LOOKUP_CACHE_MISS_MS;
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role';
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => [{ id: 'uuid-acme', slug: 'acme' }],
      }),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('uses cache for repeated lookups within TTL (single fetch)', async () => {
    await lookupTenant('acme');
    await lookupTenant('acme');
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('bypassCache skips read and write (always fetches)', async () => {
    await lookupTenant('acme', { bypassCache: true });
    await lookupTenant('acme', { bypassCache: true });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('expires success cache after TTL', async () => {
    vi.useFakeTimers();
    await lookupTenant('acme');
    expect(fetch).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(31000);
    await lookupTenant('acme');
    expect(fetch).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });

  it('TENANT_LOOKUP_CACHE_SUCCESS_MS=0 disables success caching', async () => {
    process.env.TENANT_LOOKUP_CACHE_SUCCESS_MS = '0';
    vi.resetModules();
    const { lookupTenant: lookup2, clearTenantLookupCacheForTests: clear2 } =
      await import('./tenant-registry-lookup');
    clear2();
    await lookup2('acme');
    await lookup2('acme');
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
