/**
 * Mechanical tier-2 repository merge: upstream Ycode + MasjidWeb tenant seams from main.
 *
 * Uses git merge-file (base = merge-base, ours = main, theirs = upstream/main), then
 * resolves the common import conflict and tenantId parameter shadowing.
 */
import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const REPO_ROOT = join(__dirname, '..');

const TIER2_FILES = [
  'lib/repositories/collectionFieldRepository.ts',
  'lib/repositories/collectionRepository.ts',
  'lib/repositories/collectionItemRepository.ts',
  'lib/repositories/layerStyleRepository.ts',
  'lib/repositories/pageLayersRepository.ts',
];

function gitShow(ref: string, path: string): string {
  return execSync(`git show ${ref}:${path}`, { encoding: 'utf8', cwd: REPO_ROOT });
}

function mergeImports(ours: string, theirs: string): string {
  const lines = new Set<string>();
  for (const block of [ours, theirs]) {
    for (const line of block.split('\n')) {
      const trimmed = line.trim();
      if (trimmed.startsWith('import ')) {
        lines.add(line);
      }
    }
  }
  const ordered = [...lines].sort((a, b) => {
    const score = (s: string) =>
      s.includes('masjidweb') ? 0 : s.includes('supabase-server') ? 1 : 2;
    return score(a) - score(b) || a.localeCompare(b);
  });
  return ordered.join('\n');
}

function resolveImportConflict(content: string): string {
  const pattern =
    /<<<<<<<[^\n]*\n([\s\S]*?)=======\n([\s\S]*?)>>>>>>>[^\n]*\n/g;
  return content.replace(pattern, (full, ours, theirs) => {
    const oursImports = ours.trim();
    const theirsImports = theirs.trim();
    if (
      !oursImports.includes('import ') ||
      !theirsImports.includes('import ')
    ) {
      return full;
    }
    return `${mergeImports(oursImports, theirsImports)}\n`;
  });
}

/** Avoid `tenantId` param shadowed by `const tenantId = await resolveEffectiveTenantId()`. */
function fixTenantIdShadowing(content: string): string {
  if (!content.includes('tenantId?: string')) {
    return content;
  }
  return content.replace(
    /const tenantId = await resolveEffectiveTenantId\(\);/g,
    'const effectiveTenantId = await resolveEffectiveTenantId();',
  ).replace(
    /if \(tenantId\) \{\s*\n\s*(\w+) = \1\.eq\('tenant_id', tenantId\);/g,
    "if (effectiveTenantId) {\n      $1 = $1.eq('tenant_id', effectiveTenantId);",
  );
}

function reapplyFile(path: string, mergeBase: string): { path: string; conflicts: number } {
  const ours = gitShow('main', path);
  const base = gitShow(mergeBase, path);
  const theirs = gitShow('upstream/main', path);

  const oursPath = join(REPO_ROOT, '.tmp-merge-ours');
  const basePath = join(REPO_ROOT, '.tmp-merge-base');
  const theirsPath = join(REPO_ROOT, '.tmp-merge-theirs');
  const outPath = join(REPO_ROOT, '.tmp-merge-out');

  writeFileSync(oursPath, ours);
  writeFileSync(basePath, base);
  writeFileSync(theirsPath, theirs);

  try {
    execSync(`git merge-file -p "${oursPath}" "${basePath}" "${theirsPath}"`, {
      encoding: 'utf8',
      cwd: REPO_ROOT,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (error: unknown) {
    const err = error as { stdout?: string };
    if (typeof err.stdout === 'string' && err.stdout.length > 0) {
      writeFileSync(outPath, err.stdout);
    } else {
      throw error;
    }
  }

  let merged = readFileSync(outPath, 'utf8');
  merged = resolveImportConflict(merged);
  merged = fixTenantIdShadowing(merged);

  const conflicts = (merged.match(/^<<<<<<< /gm) ?? []).length;
  if (conflicts > 0) {
    throw new Error(
      `${path}: ${conflicts} unresolved conflict(s) after mechanical merge — resolve manually`,
    );
  }

  writeFileSync(join(REPO_ROOT, path), merged);
  return { path, conflicts: 0 };
}

function main(): void {
  const mergeBase = execSync('git merge-base main upstream/main', {
    encoding: 'utf8',
    cwd: REPO_ROOT,
  }).trim();

  console.log(`Merge base: ${mergeBase}`);

  for (const file of TIER2_FILES) {
    const result = reapplyFile(file, mergeBase);
    console.log(`OK ${result.path}`);
  }

  console.log('Tier-2 seam reapply complete.');
}

main();
