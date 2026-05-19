import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  requireTemplateTenantForUpdates: vi.fn(),
  checkForUpdates: vi.fn(),
  getAdminUpdateCenterStatus: vi.fn(),
  prepareSafeUpdate: vi.fn(),
  fetch: vi.fn(),
}));

vi.mock('@/lib/masjidweb/update-tenant-access', () => ({
  requireTemplateTenantForUpdates: mocks.requireTemplateTenantForUpdates,
}));

vi.mock('@/lib/updates/check-updates', () => ({
  checkForUpdates: mocks.checkForUpdates,
}));

vi.mock('@/lib/masjidweb/update-center', () => ({
  getAdminUpdateCenterStatus: mocks.getAdminUpdateCenterStatus,
  prepareSafeUpdate: mocks.prepareSafeUpdate,
}));

import { GET as getCheck } from '@/app/(builder)/ycode/api/updates/check/route';
import { GET as getReleases } from '@/app/(builder)/ycode/api/updates/releases/route';
import { POST as postPrepare } from '@/app/(builder)/ycode/api/updates/prepare/route';
import { GET as getStatus } from '@/app/(builder)/ycode/api/updates/status/route';

describe('update API tenant gates', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('fetch', mocks.fetch);
  });

  it('blocks update checks before running update logic when tenant is not template', async () => {
    const forbidden = Response.json({ error: 'blocked' }, { status: 403 });
    mocks.requireTemplateTenantForUpdates.mockResolvedValue(forbidden);

    const response = await getCheck();

    expect(response.status).toBe(403);
    expect(mocks.checkForUpdates).not.toHaveBeenCalled();
  });

  it('allows update checks for template tenants', async () => {
    mocks.requireTemplateTenantForUpdates.mockResolvedValue(null);
    mocks.checkForUpdates.mockResolvedValue({ available: false, currentVersion: '1.6.1' });

    const response = await getCheck();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({ available: false, currentVersion: '1.6.1' });
    expect(mocks.checkForUpdates).toHaveBeenCalledWith('1.6.1');
  });

  it('blocks release history before fetching GitHub releases when tenant is not template', async () => {
    const forbidden = Response.json({ error: 'blocked' }, { status: 403 });
    mocks.requireTemplateTenantForUpdates.mockResolvedValue(forbidden);

    const response = await getReleases();

    expect(response.status).toBe(403);
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it('allows release history for template tenants', async () => {
    mocks.requireTemplateTenantForUpdates.mockResolvedValue(null);
    mocks.fetch.mockResolvedValue({
      ok: true,
      json: async () => [
        {
          tag_name: 'v1.6.1',
          name: 'Version 1.6.1',
          body: 'Release notes',
          published_at: '2026-01-01T00:00:00.000Z',
          html_url: 'https://github.com/ycode/ycode/releases/tag/v1.6.1',
          prerelease: false,
          draft: false,
        },
      ],
    });

    const response = await getReleases();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.currentVersion).toBe('1.6.1');
    expect(body.releases).toHaveLength(1);
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
  });

  it('blocks admin update status before reading GitHub when tenant is not template', async () => {
    const forbidden = Response.json({ error: 'blocked' }, { status: 403 });
    mocks.requireTemplateTenantForUpdates.mockResolvedValue(forbidden);

    const response = await getStatus();

    expect(response.status).toBe(403);
    expect(mocks.getAdminUpdateCenterStatus).not.toHaveBeenCalled();
  });

  it('allows admin update status for template tenants', async () => {
    mocks.requireTemplateTenantForUpdates.mockResolvedValue(null);
    mocks.getAdminUpdateCenterStatus.mockResolvedValue({
      ok: true,
      status: 'up_to_date',
      title: 'You are up to date',
      description: 'The MasjidWeb builder is already using the latest known Ycode core version.',
      currentVersion: '1.6.1',
      canPrepare: false,
      productionProtected: true,
    });

    const response = await getStatus();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.status).toBe('up_to_date');
    expect(mocks.getAdminUpdateCenterStatus).toHaveBeenCalledWith('1.6.1');
  });

  it('blocks safe update preparation before triggering workflow when tenant is not template', async () => {
    const forbidden = Response.json({ error: 'blocked' }, { status: 403 });
    mocks.requireTemplateTenantForUpdates.mockResolvedValue(forbidden);

    const response = await postPrepare();

    expect(response.status).toBe(403);
    expect(mocks.prepareSafeUpdate).not.toHaveBeenCalled();
  });

  it('allows safe update preparation for template tenants', async () => {
    mocks.requireTemplateTenantForUpdates.mockResolvedValue(null);
    mocks.prepareSafeUpdate.mockResolvedValue({
      ok: true,
      message: 'Safe update preparation has started. Production has not changed.',
    });

    const response = await postPrepare();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.message).toContain('Production has not changed');
    expect(mocks.prepareSafeUpdate).toHaveBeenCalledTimes(1);
  });
});
