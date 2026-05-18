import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/repositories/pageRepository', () => ({
  getPageById: vi.fn(),
}));

vi.mock('@/lib/repositories/pageFolderRepository', () => ({
  getPageFolderById: vi.fn(),
}));

import { resolvePageAuthTarget } from '@/lib/page-auth-verification';

describe('resolvePageAuthTarget', () => {
  it('uses tenant-scoped page and folder lookup functions with the requested publish state', async () => {
    const getPageById = vi.fn().mockResolvedValue({ settings: {} });
    const getPageFolderById = vi.fn().mockResolvedValue({
      settings: { auth: { enabled: true, password: 'folder-secret' } },
    });

    const result = await resolvePageAuthTarget({
      pageId: 'page-1',
      folderId: 'folder-1',
      isPublished: true,
      getPageById,
      getPageFolderById,
    });

    expect(getPageById).toHaveBeenCalledWith('page-1', true);
    expect(getPageFolderById).toHaveBeenCalledWith('folder-1', true);
    expect(result).toEqual({
      expectedPassword: 'folder-secret',
      unlockType: 'folder',
      unlockId: 'folder-1',
    });
  });

  it('prefers page auth over folder auth when both are protected', async () => {
    const getPageById = vi.fn().mockResolvedValue({
      settings: { auth: { enabled: true, password: 'page-secret' } },
    });
    const getPageFolderById = vi.fn().mockResolvedValue({
      settings: { auth: { enabled: true, password: 'folder-secret' } },
    });

    const result = await resolvePageAuthTarget({
      pageId: 'page-1',
      folderId: 'folder-1',
      isPublished: false,
      getPageById,
      getPageFolderById,
    });

    expect(getPageFolderById).not.toHaveBeenCalled();
    expect(result).toEqual({
      expectedPassword: 'page-secret',
      unlockType: 'page',
      unlockId: 'page-1',
    });
  });

  it('supports settings stored as JSON strings', async () => {
    const getPageById = vi.fn().mockResolvedValue({
      settings: JSON.stringify({ auth: { enabled: true, password: 'json-secret' } }),
    });
    const getPageFolderById = vi.fn();

    await expect(
      resolvePageAuthTarget({
        pageId: 'page-1',
        isPublished: true,
        getPageById,
        getPageFolderById,
      }),
    ).resolves.toEqual({
      expectedPassword: 'json-secret',
      unlockType: 'page',
      unlockId: 'page-1',
    });
  });

  it('returns null when neither page nor folder has enabled password auth', async () => {
    const getPageById = vi.fn().mockResolvedValue({
      settings: { auth: { enabled: false, password: 'unused' } },
    });
    const getPageFolderById = vi.fn().mockResolvedValue(null);

    await expect(
      resolvePageAuthTarget({
        pageId: 'page-1',
        folderId: 'folder-1',
        isPublished: true,
        getPageById,
        getPageFolderById,
      }),
    ).resolves.toBeNull();
  });
});
