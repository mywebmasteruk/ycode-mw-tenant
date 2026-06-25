import { normalize, sep } from 'node:path';

const FORBIDDEN_DIFF_PATH_SEGMENTS = new Set(['', '.', '..', '.git', 'node_modules']);
const MIN_REPAIRED_CONTENT_CHARS = 20;

export type PremiumAiPatch = {
  filePath: string;
  unifiedDiff: string;
};

export type PremiumAiResolvedFile = {
  filePath: string;
  content: string;
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

function parseHunkCount(value: string | undefined): number {
  if (!value) return 1;
  const parsed = Number.parseInt(value.slice(1), 10);
  return Number.isFinite(parsed) ? parsed : 1;
}

export function assertUnifiedDiffSyntax(diff: string, filePath: string): void {
  const lines = diff.split('\n');
  let expectedOld = 0;
  let expectedNew = 0;
  let actualOld = 0;
  let actualNew = 0;
  let inHunk = false;

  function finishHunk(): void {
    if (!inHunk) return;
    if (actualOld !== expectedOld || actualNew !== expectedNew) {
      throw new Error(
        `Premium AI patch for ${filePath} has malformed hunk counts (expected -${expectedOld}/+${expectedNew}, got -${actualOld}/+${actualNew})`,
      );
    }
  }

  for (const line of lines) {
    const header = line.match(/^@@ -(?:\d+)(,\d+)? \+(?:\d+)(,\d+)? @@/);
    if (header) {
      finishHunk();
      expectedOld = parseHunkCount(header[1]);
      expectedNew = parseHunkCount(header[2]);
      actualOld = 0;
      actualNew = 0;
      inHunk = true;
      continue;
    }

    if (!inHunk) continue;
    if (line.startsWith('--- ') || line.startsWith('+++ ')) {
      finishHunk();
      inHunk = false;
      continue;
    }
    if (line.startsWith('\\')) continue;
    if (line.startsWith(' ')) {
      actualOld += 1;
      actualNew += 1;
    } else if (line.startsWith('-')) {
      actualOld += 1;
    } else if (line.startsWith('+')) {
      actualNew += 1;
    } else if (line === '') {
      actualOld += 1;
      actualNew += 1;
    }
  }

  finishHunk();
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
  assertUnifiedDiffSyntax(patch.unifiedDiff, patch.filePath);
}

export function decodePremiumAiContent(entry: unknown): string | null {
  const item = entry as { content?: unknown; contentBase64?: unknown };
  // Prefer a non-empty plain `content`; otherwise fall back to `contentBase64`
  // (the mandated form for resolved files — it avoids the JSON-escaping failures
  // that large raw `content` strings cause, the root of invalid_json).
  if (typeof item.content === 'string' && item.content.length > 0) return item.content;
  if (typeof item.contentBase64 === 'string' && item.contentBase64.length > 0) {
    try {
      return Buffer.from(item.contentBase64, 'base64').toString('utf8');
    } catch {
      return null;
    }
  }
  if (typeof item.content === 'string') return item.content;
  return null;
}

export function assertResolvedFileTarget(file: PremiumAiResolvedFile, allowedFiles: Set<string>): string {
  const declared = normalizeDiffPath(file.filePath);
  if (!declared || !allowedFiles.has(declared)) {
    throw new Error(`Premium AI content replacement targets disallowed file: ${file.filePath}`);
  }
  return declared;
}

export function assertResolvedFileContent(file: PremiumAiResolvedFile): void {
  if (file.content.trim().length < MIN_REPAIRED_CONTENT_CHARS) {
    throw new Error(`Premium AI content replacement for ${file.filePath} is empty or too short`);
  }
  if (/^<<<<<<<|^=======|^>>>>>>>|^\|\|\|\|\|\|\|/m.test(file.content)) {
    throw new Error(`Premium AI content replacement for ${file.filePath} still contains conflict markers`);
  }
}
