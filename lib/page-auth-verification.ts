import { getPageById } from '@/lib/repositories/pageRepository';
import { getPageFolderById } from '@/lib/repositories/pageFolderRepository';

type AuthSettings = {
  auth?: {
    enabled?: boolean;
    password?: string;
  };
};

type PageAuthRecord = {
  settings?: AuthSettings | string | null;
};

type LookupPageById = (id: string, isPublished: boolean) => Promise<PageAuthRecord | null>;
type LookupPageFolderById = (id: string, isPublished: boolean) => Promise<PageAuthRecord | null>;

export type PageAuthTarget = {
  expectedPassword: string;
  unlockType: 'page' | 'folder';
  unlockId: string;
};

type ResolvePageAuthTargetInput = {
  pageId?: string;
  folderId?: string;
  isPublished: boolean;
  getPageById?: LookupPageById;
  getPageFolderById?: LookupPageFolderById;
};

function parseSettings(settings: PageAuthRecord['settings']): AuthSettings | null {
  if (!settings) return null;
  if (typeof settings !== 'string') return settings;
  return JSON.parse(settings) as AuthSettings;
}

function authPasswordFromRecord(record: PageAuthRecord | null): string | null {
  const settings = parseSettings(record?.settings);
  const password = settings?.auth?.password;
  if (settings?.auth?.enabled && typeof password === 'string' && password) {
    return password;
  }
  return null;
}

export async function resolvePageAuthTarget({
  pageId,
  folderId,
  isPublished,
  getPageById: lookupPageById = getPageById,
  getPageFolderById: lookupPageFolderById = getPageFolderById,
}: ResolvePageAuthTargetInput): Promise<PageAuthTarget | null> {
  if (pageId) {
    const page = await lookupPageById(pageId, isPublished);
    const expectedPassword = authPasswordFromRecord(page);
    if (expectedPassword) {
      return {
        expectedPassword,
        unlockType: 'page',
        unlockId: pageId,
      };
    }
  }

  if (folderId) {
    const folder = await lookupPageFolderById(folderId, isPublished);
    const expectedPassword = authPasswordFromRecord(folder);
    if (expectedPassword) {
      return {
        expectedPassword,
        unlockType: 'folder',
        unlockId: folderId,
      };
    }
  }

  return null;
}
