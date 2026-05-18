import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createApiKey, deleteApiKey, getAllApiKeys, getApiKeyById, validateApiKey } from './apiKeyRepository';

const mocks = vi.hoisted(() => ({
  getSupabaseAdmin: vi.fn(),
}));

vi.mock('@/lib/supabase-server', () => ({
  getSupabaseAdmin: mocks.getSupabaseAdmin,
}));

function queryMock(result: unknown = { data: [], error: null }) {
  const query = {
    from: vi.fn().mockReturnThis(),
    select: vi.fn().mockReturnThis(),
    insert: vi.fn().mockReturnThis(),
    update: vi.fn().mockReturnThis(),
    delete: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    or: vi.fn().mockReturnThis(),
    order: vi.fn().mockReturnThis(),
    single: vi.fn().mockResolvedValue(result),
    then: (resolve: (value: unknown) => unknown, reject: (reason?: unknown) => unknown) =>
      Promise.resolve(result).then(resolve, reject),
  };
  return query;
}

describe('apiKeyRepository tenant scope', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('filters listed API keys to the active tenant plus legacy unscoped keys', async () => {
    const query = queryMock({ data: [], error: null });
    const client = { from: vi.fn().mockReturnValue(query) };
    mocks.getSupabaseAdmin.mockResolvedValue(client);

    await getAllApiKeys('tenant-1');
    expect(query.or).toHaveBeenCalledWith('tenant_id.eq.tenant-1,tenant_id.is.null');
  });

  it('falls back to legacy list behavior if tenant_id has not been migrated yet', async () => {
    const scopedQuery = queryMock({
      data: null,
      error: { code: '42703', message: 'column api_keys.tenant_id does not exist' },
    });
    const legacyQuery = queryMock({ data: [], error: null });
    const client = {
      from: vi.fn()
        .mockReturnValueOnce(scopedQuery)
        .mockReturnValueOnce(legacyQuery),
    };
    mocks.getSupabaseAdmin.mockResolvedValue(client);

    await getAllApiKeys('tenant-1');

    expect(scopedQuery.or).toHaveBeenCalledWith('tenant_id.eq.tenant-1,tenant_id.is.null');
    expect(legacyQuery.or).not.toHaveBeenCalled();
  });

  it('stores tenant_id when creating a key with tenant context', async () => {
    const query = queryMock({
      data: {
        id: 'key-1',
        name: 'Production',
        key_prefix: 'abcdef12',
        last_used_at: null,
        created_at: '2026-01-01T00:00:00.000Z',
        updated_at: '2026-01-01T00:00:00.000Z',
      },
      error: null,
    });
    const client = { from: vi.fn().mockReturnValue(query) };
    mocks.getSupabaseAdmin.mockResolvedValue(client);

    await createApiKey('Production', 'tenant-1');

    expect(query.insert).toHaveBeenCalledWith(expect.objectContaining({
      name: 'Production',
      tenant_id: 'tenant-1',
    }));
  });

  it('validates keys only within the active tenant plus legacy unscoped keys', async () => {
    const selectQuery = queryMock({
      data: {
        id: 'key-1',
        name: 'Production',
        key_prefix: 'abcdef12',
        last_used_at: null,
        created_at: '2026-01-01T00:00:00.000Z',
        updated_at: '2026-01-01T00:00:00.000Z',
      },
      error: null,
    });
    const updateQuery = queryMock({ data: null, error: null });
    const client = {
      from: vi.fn()
        .mockReturnValueOnce(selectQuery)
        .mockReturnValueOnce(updateQuery),
    };
    mocks.getSupabaseAdmin.mockResolvedValue(client);

    await validateApiKey('plain-key', 'tenant-1');

    expect(selectQuery.eq).toHaveBeenCalledWith('key_hash', expect.any(String));
    expect(selectQuery.or).toHaveBeenCalledWith('tenant_id.eq.tenant-1,tenant_id.is.null');
    expect(updateQuery.eq).toHaveBeenCalledWith('id', 'key-1');
    expect(updateQuery.or).toHaveBeenCalledWith('tenant_id.eq.tenant-1,tenant_id.is.null');
  });

  it('requires tenant scope when fetching or deleting by id', async () => {
    const fetchQuery = queryMock({ data: null, error: { code: 'PGRST116', message: 'not found' } });
    const deleteQuery = queryMock({ data: null, error: null });
    const client = {
      from: vi.fn()
        .mockReturnValueOnce(fetchQuery)
        .mockReturnValueOnce(deleteQuery),
    };
    mocks.getSupabaseAdmin.mockResolvedValue(client);

    await getApiKeyById('key-1', 'tenant-1');
    await deleteApiKey('key-1', 'tenant-1');

    expect(fetchQuery.eq).toHaveBeenCalledWith('id', 'key-1');
    expect(fetchQuery.or).toHaveBeenCalledWith('tenant_id.eq.tenant-1,tenant_id.is.null');
    expect(deleteQuery.eq).toHaveBeenCalledWith('id', 'key-1');
    expect(deleteQuery.or).toHaveBeenCalledWith('tenant_id.eq.tenant-1,tenant_id.is.null');
  });
});
