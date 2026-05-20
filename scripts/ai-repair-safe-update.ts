import { execSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  assertNoConflictMarkers,
  DEFAULT_AI_REPAIR_MODEL,
  requestOpenRouterRepair,
  stripCodeFences,
} from '../lib/masjidweb/openrouter-repair';

const REPO_ROOT = join(__dirname, '..');
const MAX_FILE_CHARS = 120_000;
const SEAMS_PATH = join(REPO_ROOT, 'docs/masjidweb-core-seams.md');

function run(command: string): string {
  return execSync(command, { encoding: 'utf8', cwd: REPO_ROOT }).trim();
}

function listLines(command: string): string[] {
  const out = run(command);
  if (!out) return [];
  return out.split('\n').map((line) => line.trim()).filter(Boolean);
}

function listConflictFiles(): string[] {
  const unmerged = listLines('git diff --name-only --diff-filter=U');
  if (unmerged.length > 0) return unmerged;

  try {
    return listLines('git grep -l "^<<<<<<<" -- . ":(exclude)node_modules"');
  } catch {
    return [];
  }
}

function loadSeamsExcerpt(): string {
  if (!existsSync(SEAMS_PATH)) {
    return 'Preserve MasjidWeb tenant isolation. Never remove tenant_id scoping.';
  }
  const full = readFileSync(SEAMS_PATH, 'utf8');
  return full.length > 12_000 ? `${full.slice(0, 12_000)}\n…(truncated)` : full;
}

function buildSystemPrompt(): string {
  return [
    'You are a senior developer repairing a MasjidWeb fork of Ycode after an upstream merge.',
    'Output ONLY the full resolved file contents — no explanation, no markdown fences unless the file itself is markdown.',
    'Rules:',
    '- Remove all Git conflict markers (<<<<<<<, =======, >>>>>>>).',
    '- Keep MASJIDWEB_SEAM blocks and tenant scoping (resolveEffectiveTenantId, applyTenantEq, tenant_id).',
    '- Never drop tenant isolation to match upstream.',
    '- Prefer MasjidWeb Tier 0 paths under lib/masjidweb/ when choosing between implementations.',
    '',
    'MasjidWeb seam reference:',
    loadSeamsExcerpt(),
  ].join('\n');
}

async function resolveConflictFile(
  apiKey: string,
  model: string,
  filePath: string,
): Promise<void> {
  const absolute = join(REPO_ROOT, filePath);
  if (!existsSync(absolute)) {
    throw new Error(`Conflict file missing on disk: ${filePath}`);
  }

  const original = readFileSync(absolute, 'utf8');
  if (!/^<<<<<<<|^=======|^>>>>>>>/m.test(original)) {
    console.log(`Skip ${filePath} (no conflict markers)`);
    return;
  }
  if (original.length > MAX_FILE_CHARS) {
    throw new Error(`File too large for automated repair (${filePath})`);
  }

  console.log(`Resolving ${filePath} with ${model}…`);
  const result = await requestOpenRouterRepair({
    apiKey,
    model,
    messages: [
      { role: 'system', content: buildSystemPrompt() },
      {
        role: 'user',
        content: [
          `Resolve merge conflicts in this file: ${filePath}`,
          'Return the complete file content only.',
          '',
          original,
        ].join('\n'),
      },
    ],
  });

  const resolved = stripCodeFences(result.reply);
  assertNoConflictMarkers(resolved, filePath);

  if (resolved === original) {
    throw new Error(`Model returned unchanged content for ${filePath}`);
  }

  writeFileSync(absolute, resolved.endsWith('\n') ? resolved : `${resolved}\n`, 'utf8');
  run(`git add -- "${filePath}"`);
  console.log(`Resolved ${filePath} (${result.model})`);
}

async function main(): Promise<void> {
  const apiKey = process.env.OPENROUTER_API_KEY?.trim();
  if (!apiKey) {
    throw new Error(
      'OPENROUTER_API_KEY is not set. Add it as a GitHub Actions secret on this repository.',
    );
  }

  const model = process.env.OPENROUTER_MODEL?.trim() || DEFAULT_AI_REPAIR_MODEL;
  const prNumber = process.env.PR_NUMBER?.trim();
  if (prNumber) {
    console.log(`AI repair for PR #${prNumber}`);
  }

  const files = listConflictFiles();
  if (files.length === 0) {
    console.log('No conflicted files found — nothing to repair.');
    return;
  }

  console.log(`Found ${files.length} conflicted file(s).`);
  for (const file of files) {
    await resolveConflictFile(apiKey, model, file);
  }

  const remaining = listConflictFiles();
  if (remaining.length > 0) {
    throw new Error(`Unresolved conflicts remain: ${remaining.join(', ')}`);
  }

  console.log('All listed conflicts resolved in working tree.');
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
