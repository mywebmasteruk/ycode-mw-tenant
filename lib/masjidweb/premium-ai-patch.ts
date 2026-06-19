import { normalize, sep } from 'node:path';

const FORBIDDEN_DIFF_PATH_SEGMENTS = new Set(['', '.', '..', '.git', 'node_modules']);

export type PremiumAiPatch = {
  filePath: string;
  unifiedDiff: string;
};

export function normalizeDiffPath(path: string): string | null {
  const withoutPrefix = path.replace(/^([ab])\//, '').trim();
  if (!withoutPrefix || withoutPrefix === '/dev/null') return null;
  const normalized = normalize(withoutPrefix).replaceAll('\\', '/');
  const segments = normalized.split('/');
  if (segments.some((segment) => FORBIDDEN_DIFF_PATH_SEGMENTS.has(segment))) return null;
  if (normalized.startsWith('/') || normalized.includes(`..${sep}`) || normalized === '..') return null;
  return normalized;
}

export function filesMentionedInDiff(diff: string): string[] {
  const files: string[] = [];
  for (const line of diff.split('\n')) {
    if (line.startsWith('--- ') || line.startsWith('+++ ')) {
      const rawPath = line.slice(4).trim().split(/\s+/)[0];
      const normalized = normalizeDiffPath(rawPath);
      if (normalized) files.push(normalized);
    }
  }
  return [...new Set(files.filter(Boolean))].sort();
}

export function assertPatchTargets(patch: PremiumAiPatch, allowedFiles: Set<string>): void {
  const declared = normalizeDiffPath(patch.filePath);
  if (!declared || !allowedFiles.has(declared)) {
    throw new Error(`Premium AI patch targets disallowed file: ${patch.filePath}`);
  }
  if (!patch.unifiedDiff.includes('\n--- ') && !patch.unifiedDiff.startsWith('--- ')) {
    throw new Error(`Premium AI patch for ${patch.filePath} is not a unified diff`);
  }
  if (!patch.unifiedDiff.includes('\n+++ ')) {
    throw new Error(`Premium AI patch for ${patch.filePath} is missing +++ header`);
  }
  const diffFiles = filesMentionedInDiff(patch.unifiedDiff);
  if (diffFiles.length === 0) {
    throw new Error(`Premium AI patch for ${patch.filePath} contains no file headers`);
  }
  for (const file of diffFiles) {
    if (!allowedFiles.has(file)) {
      throw new Error(`Premium AI patch includes disallowed file: ${file}`);
    }
  }
}
