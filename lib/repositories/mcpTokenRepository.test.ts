import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createToken, deleteToken, getAllTokens, getTokenById, validateToken } from './mcpTokenRepository';

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

describe('mcpTokenRepository tenant scope', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('filters listed MCP tokens to the active tenant plus legacy unscoped tokens', async () => {
    const query = queryMock({ data: [], error: null });
    const client = { from: vi.fn().mockReturnValue(query) };
    mocks.getSupabaseAdmin.mockResolvedValue(client);

    await getAllTokens('tenant-1');

    expect(query.or).toHaveBeenCalledWith('tenant_id.eq.tenant-1,tenant_id.is.null');
  });

  it('stores tenant_id when creating an MCP token with tenant context', async () => {
    const query = queryMock({
      data: {
        id: 'token-1',
        name: 'Claude',
        token: 'ymc_plain',
        token_prefix: 'ymc_plain',
        tenant_id: 'tenant-1',
        is_active: true,
        last_used_at: null,
        created_at: '2026-01-01T00:00:00.000Z',
        updated_at: '2026-01-01T00:00:00.000Z',
      },
      error: null,
    });
    const client = { from: vi.fn().mockReturnValue(query) };
    mocks.getSupabaseAdmin.mockResolvedValue(client);

    await createToken('Claude', 'tenant-1');

    expect(query.insert).toHaveBeenCalledWith(expect.objectContaining({
      name: 'Claude',
      tenant_id: 'tenant-1',
    }));
  });

  it('returns tenant_id when validating an active MCP token', async () => {
    const selectQuery = queryMock({
      data: {
        id: 'token-1',
        name: 'Claude',
        token_prefix: 'ymc_plain',
        tenant_id: 'tenant-1',
        is_active: true,
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

    const token = await validateToken('ymc_plain');

    expect(selectQuery.select).toHaveBeenCalledWith(expect.stringContaining('tenant_id'));
    expect(updateQuery.eq).toHaveBeenCalledWith('id', 'token-1');
    expect(updateQuery.or).toHaveBeenCalledWith('tenant_id.eq.tenant-1,tenant_id.is.null');
    expect(token).toMatchObject({ tenant_id: 'tenant-1' });
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

    await getTokenById('token-1', 'tenant-1');
    await deleteToken('token-1', 'tenant-1');

    expect(fetchQuery.eq).toHaveBeenCalledWith('id', 'token-1');
    expect(fetchQuery.or).toHaveBeenCalledWith('tenant_id.eq.tenant-1,tenant_id.is.null');
    expect(deleteQuery.eq).toHaveBeenCalledWith('id', 'token-1');
    expect(deleteQuery.or).toHaveBeenCalledWith('tenant_id.eq.tenant-1,tenant_id.is.null');
  });
});
