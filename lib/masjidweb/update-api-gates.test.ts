import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  requireTemplateTenantForUpdates: vi.fn(),
  checkForUpdates: vi.fn(),
  fetch: vi.fn(),
}));

vi.mock('@/lib/masjidweb/update-tenant-access', () => ({
  requireTemplateTenantForUpdates: mocks.requireTemplateTenantForUpdates,
}));

vi.mock('@/lib/updates/check-updates', () => ({
  checkForUpdates: mocks.checkForUpdates,
}));

import { GET as getCheck } from '@/app/(builder)/ycode/api/updates/check/route';
import { GET as getReleases } from '@/app/(builder)/ycode/api/updates/releases/route';

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
    mocks.checkForUpdates.mockResolvedValue({ available: false, currentVersion: '0.13.0' });

    const response = await getCheck();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({ available: false, currentVersion: '0.13.0' });
    expect(mocks.checkForUpdates).toHaveBeenCalledWith('0.13.0');
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
          tag_name: 'v0.13.0',
          name: 'Version 0.13.0',
          body: 'Release notes',
          published_at: '2026-01-01T00:00:00.000Z',
          html_url: 'https://github.com/ycode/ycode/releases/tag/v0.13.0',
          prerelease: false,
          draft: false,
        },
      ],
    });

    const response = await getReleases();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.currentVersion).toBe('0.13.0');
    expect(body.releases).toHaveLength(1);
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
  });
});
