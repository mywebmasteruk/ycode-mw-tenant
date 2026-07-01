import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  bulkDeleteFormSubmissions,
  createFormSubmission,
  deleteFormSubmission,
  deleteFormSubmissionsByFormId,
  getAllFormSubmissions,
  getFormSubmissionById,
  getFormSummaries,
  markAllAsRead,
  updateFormSubmission,
} from './formSubmissionRepository';

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
    in: vi.fn().mockReturnThis(),
    or: vi.fn().mockReturnThis(),
    order: vi.fn().mockReturnThis(),
    limit: vi.fn().mockReturnThis(),
    single: vi.fn().mockResolvedValue(result),
    then: (resolve: (value: unknown) => unknown, reject: (reason?: unknown) => unknown) =>
      Promise.resolve(result).then(resolve, reject),
  };
  return query;
}

describe('formSubmissionRepository tenant scope', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('filters list queries to active tenant plus legacy unscoped submissions', async () => {
    const query = queryMock({ data: [], error: null });
    const client = { from: vi.fn().mockReturnValue(query) };
    mocks.getSupabaseAdmin.mockResolvedValue(client);

    await getAllFormSubmissions('contact', 'new', 'tenant-1');
    expect(query.eq).toHaveBeenCalledWith('form_id', 'contact');
    expect(query.eq).toHaveBeenCalledWith('status', 'new');
    expect(query.or).toHaveBeenCalledWith('tenant_id.eq.tenant-1,tenant_id.is.null');
  });

  it('falls back to legacy list behavior if tenant_id has not been migrated yet', async () => {
    const scopedQuery = queryMock({
      data: null,
      error: { code: '42703', message: 'column form_submissions.tenant_id does not exist' },
    });
    const legacyQuery = queryMock({ data: [], error: null });
    const client = {
      from: vi.fn()
        .mockReturnValueOnce(scopedQuery)
        .mockReturnValueOnce(legacyQuery),
    };
    mocks.getSupabaseAdmin.mockResolvedValue(client);

    await getAllFormSubmissions('contact', 'new', 'tenant-1');

    expect(scopedQuery.or).toHaveBeenCalledWith('tenant_id.eq.tenant-1,tenant_id.is.null');
    expect(legacyQuery.or).not.toHaveBeenCalled();
  });

  it('filters form summaries to active tenant plus legacy unscoped submissions', async () => {
    const query = queryMock({ data: [], error: null });
    const client = { from: vi.fn().mockReturnValue(query) };
    mocks.getSupabaseAdmin.mockResolvedValue(client);

    await getFormSummaries('tenant-1');

    expect(query.select).toHaveBeenCalledWith('form_id, status, created_at');
    expect(query.or).toHaveBeenCalledWith('tenant_id.eq.tenant-1,tenant_id.is.null');
  });

  it('stores tenant_id when creating a form submission with tenant context', async () => {
    const query = queryMock({
      data: {
        id: 'submission-1',
        form_id: 'contact',
        payload: {},
        metadata: null,
        status: 'new',
        created_at: '2026-01-01T00:00:00.000Z',
      },
      error: null,
    });
    const client = { from: vi.fn().mockReturnValue(query) };
    mocks.getSupabaseAdmin.mockResolvedValue(client);

    await createFormSubmission({ form_id: 'contact', payload: {} }, 'tenant-1');

    expect(query.insert).toHaveBeenCalledWith(expect.objectContaining({
      form_id: 'contact',
      tenant_id: 'tenant-1',
    }));
  });

  it('requires tenant scope for get/update/delete by submission id', async () => {
    const getQuery = queryMock({ data: null, error: { code: 'PGRST116', message: 'not found' } });
    const updateQuery = queryMock({ data: null, error: null });
    const deleteQuery = queryMock({ data: null, error: null });
    const client = {
      from: vi.fn()
        .mockReturnValueOnce(getQuery)
        .mockReturnValueOnce(updateQuery)
        .mockReturnValueOnce(deleteQuery),
    };
    mocks.getSupabaseAdmin.mockResolvedValue(client);

    await getFormSubmissionById('submission-1', 'tenant-1');
    await updateFormSubmission('submission-1', { status: 'read' }, 'tenant-1');
    await deleteFormSubmission('submission-1', 'tenant-1');

    for (const query of [getQuery, updateQuery, deleteQuery]) {
      expect(query.eq).toHaveBeenCalledWith('id', 'submission-1');
      expect(query.or).toHaveBeenCalledWith('tenant_id.eq.tenant-1,tenant_id.is.null');
    }
  });

  it('requires tenant scope for bulk and form-level mutations', async () => {
    const bulkDeleteQuery = queryMock({ data: null, error: null });
    const formDeleteQuery = queryMock({ data: null, error: null });
    const markReadQuery = queryMock({ data: null, error: null });
    const client = {
      from: vi.fn()
        .mockReturnValueOnce(bulkDeleteQuery)
        .mockReturnValueOnce(formDeleteQuery)
        .mockReturnValueOnce(markReadQuery),
    };
    mocks.getSupabaseAdmin.mockResolvedValue(client);

    await bulkDeleteFormSubmissions(['submission-1'], 'tenant-1');
    await deleteFormSubmissionsByFormId('contact', 'tenant-1');
    await markAllAsRead('contact', 'tenant-1');

    expect(bulkDeleteQuery.in).toHaveBeenCalledWith('id', ['submission-1']);
    expect(bulkDeleteQuery.or).toHaveBeenCalledWith('tenant_id.eq.tenant-1,tenant_id.is.null');
    expect(formDeleteQuery.eq).toHaveBeenCalledWith('form_id', 'contact');
    expect(formDeleteQuery.or).toHaveBeenCalledWith('tenant_id.eq.tenant-1,tenant_id.is.null');
    expect(markReadQuery.eq).toHaveBeenCalledWith('form_id', 'contact');
    expect(markReadQuery.eq).toHaveBeenCalledWith('status', 'new');
    expect(markReadQuery.or).toHaveBeenCalledWith('tenant_id.eq.tenant-1,tenant_id.is.null');
  });

  it('keeps legacy behavior when tenant context is unavailable', async () => {
    const query = queryMock({ data: [], error: null });
    const client = { from: vi.fn().mockReturnValue(query) };
    mocks.getSupabaseAdmin.mockResolvedValue(client);

    await getAllFormSubmissions('contact');

    expect(query.eq).toHaveBeenCalledWith('form_id', 'contact');
    expect(query.or).not.toHaveBeenCalled();
  });
});
