/**
 * Classify conflicted paths for safe-update repair (token/cost control).
 * See docs/masjidweb-core-seams.md and docs/core-update-process.md.
 */

export type ConflictRepairTier =
  | 'lockfile'
  | 'fork-only'
  | 'tier2-repository'
  | 'llm-required';

const LLM_HIGH_RISK_PREFIXES = [
  'proxy.ts',
  'next.config.ts',
  'netlify.toml',
  'lib/page-fetcher.ts',
  'lib/services/cacheService.ts',
  'lib/services/pageService.ts',
  'lib/services/collectionService.ts',
  'lib/services/localisationService.ts',
  'lib/services/folderService.ts',
  'app/(builder)/ycode/api/publish/',
  'app/(builder)/ycode/api/auth/',
  'app/(builder)/ycode/accept-invite/',
  'app/(builder)/ycode/mcp/',
  'app/(builder)/ycode/YCodeLayoutClient.tsx',
  'stores/useAuthStore.ts',
];

export function classifyConflictFile(filePath: string): ConflictRepairTier {
  if (filePath === 'package-lock.json' || filePath === 'deno.lock') {
    return 'lockfile';
  }

  if (
    filePath.startsWith('lib/masjidweb/') ||
    filePath === 'lib/supabase-cookie-domain.ts' ||
    filePath === 'lib/auth-invite-redirect.ts' ||
    filePath === 'docs/masjidweb-core-seams.md'
  ) {
    return 'fork-only';
  }

  if (filePath.startsWith('lib/repositories/') && filePath.endsWith('.ts')) {
    return 'tier2-repository';
  }

  return 'llm-required';
}

export function isLlmHighRiskPath(filePath: string): boolean {
  return LLM_HIGH_RISK_PREFIXES.some(
    (prefix) => filePath === prefix || filePath.startsWith(prefix),
  );
}

export function summarizeConflictFiles(files: string[]): Record<ConflictRepairTier, string[]> {
  const summary: Record<ConflictRepairTier, string[]> = {
    lockfile: [],
    'fork-only': [],
    'tier2-repository': [],
    'llm-required': [],
  };

  for (const file of files) {
    summary[classifyConflictFile(file)].push(file);
  }

  return summary;
}
