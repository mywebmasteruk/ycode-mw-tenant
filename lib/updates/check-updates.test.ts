import { afterEach, describe, expect, it, vi } from 'vitest';
import { checkForUpdates } from './check-updates';

describe('checkForUpdates', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.VERCEL;
    delete process.env.VERCEL_GIT_PROVIDER;
    delete process.env.VERCEL_GIT_REPO_OWNER;
    delete process.env.VERCEL_GIT_REPO_SLUG;
  });

  it('points MasjidWeb updates to the safe GitHub Actions workflow instead of Sync fork', async () => {
    process.env.VERCEL = '1';
    process.env.VERCEL_GIT_PROVIDER = 'github';
    process.env.VERCEL_GIT_REPO_OWNER = 'masjidweb';
    process.env.VERCEL_GIT_REPO_SLUG = 'ycode-mw-tenant';

    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.includes('/releases/latest')) {
        return Response.json({
          tag_name: 'v1.8.0',
          html_url: 'https://github.com/ycode/ycode/releases/tag/v1.8.0',
          body: 'Release notes',
          published_at: '2026-05-18T00:00:00Z',
        });
      }

      return Response.json({
        fork: true,
        parent: { full_name: 'ycode/ycode' },
      });
    }));

    const result = await checkForUpdates('1.6.1');

    expect(result.updateInstructions?.autoSyncUrl).toBe(
      'https://github.com/masjidweb/ycode-mw-tenant/actions/workflows/sync-upstream.yml'
    );
    expect(result.updateInstructions?.steps.join(' ')).toContain('MasjidWeb safe update workflow');
    expect(result.updateInstructions?.steps.join(' ')).not.toContain('Sync fork');
  });
});
