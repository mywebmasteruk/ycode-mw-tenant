import { execSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  extractConflictHunks,
  replaceConflictHunk,
} from '../lib/masjidweb/merge-conflict-hunks';
import {
  assertNoConflictMarkers,
  DEFAULT_AI_REPAIR_MODEL,
  requestOpenRouterRepair,
  stripCodeFences,
} from '../lib/masjidweb/openrouter-repair';
import {
  classifyConflictFile,
  isLlmHighRiskPath,
  summarizeConflictFiles,
  type ConflictRepairTier,
} from '../lib/masjidweb/update-conflict-tiers';

const REPO_ROOT = join(__dirname, '..');
const MAX_FILE_CHARS = 120_000;
const MAX_HUNK_CHARS = 40_000;
const MAX_HUNKS_PER_FILE = 5;
const MAX_BATCH_HUNK_CHARS = 80_000;
const SEAMS_PATH = join(REPO_ROOT, 'docs/masjidweb-core-seams.md');

function run(command: string): string {
  return execSync(command, { encoding: 'utf8', cwd: REPO_ROOT }).trim();
}

function runAllowFailure(command: string): boolean {
  try {
    execSync(command, { encoding: 'utf8', cwd: REPO_ROOT, stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
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

function parsePositiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseBool(value: string | undefined): boolean {
  return value === '1' || value === 'true' || value === 'yes';
}

/** Env unset → use default (avoids accidental Opus on all lib/repositories). */
function parseBoolDefault(value: string | undefined, defaultValue: boolean): boolean {
  if (value === undefined || value.trim() === '') return defaultValue;
  if (value === '0' || value === 'false' || value === 'no') return false;
  return parseBool(value);
}

function tryReadGitBlob(stage: string, filePath: string): string | null {
  try {
    return execSync(`git show :${stage}:${filePath}`, {
      encoding: 'utf8',
      cwd: REPO_ROOT,
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trimEnd();
  } catch {
    return null;
  }
}

function loadSeamsExcerpt(): string {
  if (!existsSync(SEAMS_PATH)) {
    return 'Preserve MasjidWeb tenant isolation. Never remove tenant_id scoping.';
  }
  const full = readFileSync(SEAMS_PATH, 'utf8');
  return full.length > 12_000 ? `${full.slice(0, 12_000)}\n…(truncated)` : full;
}

function buildSystemPrompt(mode: 'file' | 'hunk' | 'batch'): string {
  const outputRule =
    mode === 'batch'
      ? 'Output ONLY a JSON array of strings — one resolved hunk per input hunk, same length, no conflict markers.'
      : mode === 'hunk'
        ? 'Output ONLY the merged replacement for the conflict block (no <<<<<<< / ======= / >>>>>>> / ||||||| markers).'
        : 'Output ONLY the full resolved file contents — no explanation, no markdown fences unless the file itself is markdown.';

  return [
    'You are a senior developer repairing a MasjidWeb fork of Ycode after an upstream merge.',
    outputRule,
    'Rules:',
    '- Remove all Git conflict markers (<<<<<<<, =======, >>>>>>>, |||||||).',
    '- When a ||||||| base section is present, use it to merge both sides correctly.',
    '- Keep MASJIDWEB_SEAM blocks and tenant scoping (resolveEffectiveTenantId, applyTenantEq, tenant_id).',
    '- Never drop tenant isolation to match upstream.',
    '- Prefer MasjidWeb Tier 0 paths under lib/masjidweb/ when choosing between implementations.',
    '',
    'MasjidWeb seam reference:',
    loadSeamsExcerpt(),
  ].join('\n');
}

function mergeBaseContext(filePath: string): string {
  const base = tryReadGitBlob('1', filePath);
  if (!base) return '';
  const excerpt = base.length > 8_000 ? `${base.slice(0, 8_000)}\n…(truncated)` : base;
  return ['Merge base (common ancestor) excerpt:', excerpt, ''].join('\n');
}

async function resolvePackageLockConflict(): Promise<void> {
  console.log('Regenerating package-lock.json from package.json…');
  run('npm install --package-lock-only --ignore-scripts');
  run('git add package-lock.json');
  if (!runAllowFailure('git diff --cached --quiet')) {
    run('git commit -m "fix(ai): regenerate package-lock.json after merge"');
    run('git push origin HEAD');
  }
}

async function requestResolvedConflictText(
  apiKey: string,
  model: string,
  filePath: string,
  conflictText: string,
  mode: 'file' | 'hunk' | 'batch',
): Promise<{ resolved: string; model: string }> {
  const instruction =
    mode === 'file'
      ? ['Resolve merge conflicts in this file: ' + filePath, 'Return the complete file content only.']
      : mode === 'batch'
        ? [
          `Resolve all conflict hunks in ${filePath}.`,
          'Return a JSON array of resolved hunk bodies (strings only), same order and length as the hunks below.',
        ]
        : [
          `Resolve this merge conflict hunk from ${filePath}.`,
          'Return only the merged code that replaces the conflict block.',
          'Keep surrounding logic intact; do not omit code that appears after the conflict in the file.',
        ];

  const result = await requestOpenRouterRepair({
    apiKey,
    model,
    messages: [
      { role: 'system', content: buildSystemPrompt(mode) },
      {
        role: 'user',
        content: [mergeBaseContext(filePath), ...instruction, '', conflictText].join('\n'),
      },
    ],
    maxTokens: mode === 'batch' ? 24_000 : undefined,
  });

  const resolved = stripCodeFences(result.reply);
  if (mode !== 'batch') {
    assertNoConflictMarkers(resolved, filePath);
  }
  return { resolved, model: result.model };
}

function parseBatchHunkResponse(raw: string, expectedCount: number): string[] {
  const trimmed = stripCodeFences(raw);
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    throw new Error('Batch hunk repair did not return valid JSON');
  }
  if (!Array.isArray(parsed) || parsed.length !== expectedCount) {
    throw new Error(
      `Batch hunk repair returned ${Array.isArray(parsed) ? parsed.length : 0} items; expected ${expectedCount}`,
    );
  }
  return parsed.map((entry, index) => {
    if (typeof entry !== 'string') {
      throw new Error(`Batch hunk entry ${index} is not a string`);
    }
    if (/^<<<<<<<|^=======|^>>>>>>>|^\|\|\|\|\|\|\|/m.test(entry)) {
      throw new Error(`Batch hunk entry ${index} still contains conflict markers`);
    }
    return entry;
  });
}

async function resolveConflictFileByHunks(
  apiKey: string,
  model: string,
  filePath: string,
  original: string,
): Promise<void> {
  const hunks = extractConflictHunks(original);
  if (hunks.length === 0) {
    console.log(`Skip ${filePath} (no conflict hunks)`);
    return;
  }

  if (hunks.length > MAX_HUNKS_PER_FILE) {
    throw new Error(
      `${filePath} has ${hunks.length} conflict hunks (max ${MAX_HUNKS_PER_FILE}). Resolve in IDE to save tokens.`,
    );
  }

  const totalHunkChars = hunks.reduce((sum, hunk) => sum + hunk.length, 0);

  if (hunks.length > 1 && totalHunkChars <= MAX_BATCH_HUNK_CHARS) {
    console.log(`Resolving ${filePath} (${hunks.length} hunks, single batch call)…`);
    const batchBody = hunks
      .map((hunk, index) => `--- HUNK ${index} ---\n${hunk}`)
      .join('\n\n');
    const { resolved: raw, model: usedModel } = await requestResolvedConflictText(
      apiKey,
      model,
      filePath,
      batchBody,
      'batch',
    );
    const resolvedHunks = parseBatchHunkResponse(raw, hunks.length);
    let content = original;
    for (let index = hunks.length - 1; index >= 0; index -= 1) {
      content = replaceConflictHunk(content, hunks[index], resolvedHunks[index]);
    }
    assertNoConflictMarkers(content, filePath);
    const absolute = join(REPO_ROOT, filePath);
    writeFileSync(absolute, content.endsWith('\n') ? content : `${content}\n`, 'utf8');
    run(`git add -- "${filePath}"`);
    if (!runAllowFailure('git diff --cached --quiet')) {
      run(`git commit -m "fix(ai): resolve conflicts in ${filePath}"`);
      run('git push origin HEAD');
    }
    console.log(`Resolved ${filePath} by batch hunk (${usedModel})`);
    return;
  }

  console.log(
    `Resolving ${filePath} in ${hunks.length} hunk(s) (file too large for single pass)…`,
  );

  let content = original;
  let lastModel = model;

  for (let index = 0; index < hunks.length; index += 1) {
    const hunk = hunks[index];
    if (hunk.length > MAX_HUNK_CHARS) {
      throw new Error(
        `Conflict hunk ${index + 1}/${hunks.length} in ${filePath} is too large for automated repair`,
      );
    }

    const { resolved, model: usedModel } = await requestResolvedConflictText(
      apiKey,
      model,
      filePath,
      hunk,
      'hunk',
    );
    lastModel = usedModel;

    if (resolved === hunk) {
      throw new Error(`Model returned unchanged hunk for ${filePath}`);
    }

    content = replaceConflictHunk(content, hunk, resolved);
    assertNoConflictMarkers(content, filePath);
  }

  const absolute = join(REPO_ROOT, filePath);
  writeFileSync(absolute, content.endsWith('\n') ? content : `${content}\n`, 'utf8');
  run(`git add -- "${filePath}"`);
  if (!runAllowFailure('git diff --cached --quiet')) {
    run(`git commit -m "fix(ai): resolve conflicts in ${filePath}"`);
    run('git push origin HEAD');
  }
  console.log(`Resolved ${filePath} by hunk (${lastModel})`);
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
    if (filePath === 'package-lock.json') {
      await resolvePackageLockConflict();
      return;
    }
    await resolveConflictFileByHunks(apiKey, model, filePath, original);
    return;
  }

  console.log(`Resolving ${filePath} with ${model}…`);
  const { resolved, model: usedModel } = await requestResolvedConflictText(
    apiKey,
    model,
    filePath,
    original,
    'file',
  );

  if (resolved === original) {
    throw new Error(`Model returned unchanged content for ${filePath}`);
  }

  writeFileSync(absolute, resolved.endsWith('\n') ? resolved : `${resolved}\n`, 'utf8');
  run(`git add -- "${filePath}"`);
  if (!runAllowFailure('git diff --cached --quiet')) {
    run(`git commit -m "fix(ai): resolve conflicts in ${filePath}"`);
    run('git push origin HEAD');
  }
  console.log(`Resolved ${filePath} (${usedModel})`);
}

function pickRepairModel(filePath: string, defaultModel: string): string {
  const highRiskModel = process.env.OPENROUTER_REPAIR_MODEL_HIGH_RISK?.trim();
  if (highRiskModel && isLlmHighRiskPath(filePath)) {
    return highRiskModel;
  }
  return defaultModel;
}

function writeStepSummary(lines: string[]): void {
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (!summaryPath) return;
  writeFileSync(summaryPath, `${lines.join('\n')}\n`, { flag: 'a' });
}

async function main(): Promise<void> {
  const apiKey = process.env.OPENROUTER_API_KEY?.trim();
  if (!apiKey) {
    throw new Error(
      'OPENROUTER_API_KEY is not set. Add it as a GitHub Actions secret on this repository.',
    );
  }
  if (!apiKey.startsWith('sk-or-') && !apiKey.startsWith('sk-')) {
    throw new Error(
      'OPENROUTER_API_KEY looks invalid. Set a real OpenRouter key (sk-or-…) as a GitHub Actions secret on this repository.',
    );
  }

  const mechanicalOnly = parseBool(process.env.AI_REPAIR_MECHANICAL_ONLY);
  const skipTier2Llm =
    mechanicalOnly || parseBoolDefault(process.env.AI_REPAIR_SKIP_TIER2_LLM, true);
  const maxLlmFiles = parsePositiveInt(process.env.AI_REPAIR_MAX_LLM_FILES, 8);
  const defaultModel = process.env.OPENROUTER_MODEL?.trim() || DEFAULT_AI_REPAIR_MODEL;
  const prNumber = process.env.PR_NUMBER?.trim();

  if (prNumber) {
    console.log(`AI repair for PR #${prNumber}`);
  }

  console.log('Applying recorded rerere resolutions (if any)…');
  runAllowFailure('git rerere');

  const files = listConflictFiles();
  if (files.length === 0) {
    console.log('No conflicted files found — nothing to repair.');
    return;
  }

  const initialSummary = summarizeConflictFiles(files);
  console.log(`Found ${files.length} conflicted file(s).`);
  for (const tier of Object.keys(initialSummary) as ConflictRepairTier[]) {
    const list = initialSummary[tier];
    if (list.length > 0) {
      console.log(`  ${tier}: ${list.length} file(s)`);
    }
  }

  writeStepSummary([
    '## AI repair conflict summary',
    '',
    `- Total conflicted files: **${files.length}**`,
    `- Mechanical-only mode: **${mechanicalOnly}**`,
    `- Skip Tier-2 repository LLM: **${skipTier2Llm}**`,
    `- Max LLM files this run: **${maxLlmFiles}**`,
    '',
    ...Object.entries(initialSummary).flatMap(([tier, list]) =>
      list.length > 0 ? [`### ${tier}`, ...list.map((f) => `- ${f}`), ''] : [],
    ),
  ]);

  const deferred: string[] = [];
  let llmCalls = 0;

  for (const file of [...files]) {
    const tier = classifyConflictFile(file);

    if (tier === 'lockfile') {
      if (file === 'package-lock.json') {
        await resolvePackageLockConflict();
      } else {
        console.log(`Defer ${file} (regenerate lockfile manually or in IDE)`);
        deferred.push(file);
      }
      continue;
    }

    if (tier === 'fork-only') {
      console.log(`Defer ${file} (fork-only — should be merge=ours via .gitattributes)`);
      deferred.push(file);
      continue;
    }

    if (mechanicalOnly) {
      console.log(`Defer ${file} (mechanical-only mode)`);
      deferred.push(file);
      continue;
    }

    if (tier === 'tier2-repository' && skipTier2Llm) {
      console.log(`Defer ${file} (Tier-2 repository — fix with seam re-apply in IDE, not Opus)`);
      deferred.push(file);
      continue;
    }

    if (llmCalls >= maxLlmFiles) {
      console.log(`Defer ${file} (LLM file cap ${maxLlmFiles} reached)`);
      deferred.push(file);
      continue;
    }

    const model = pickRepairModel(file, defaultModel);
    await resolveConflictFile(apiKey, model, file);
    llmCalls += 1;
  }

  const stillConflicted = listConflictFiles();

  writeStepSummary([
    '',
    '## AI repair result',
    '',
    `- LLM files repaired this run: **${llmCalls}**`,
    `- Deferred (manual / next run): **${deferred.length}**`,
    `- Unresolved conflict markers: **${stillConflicted.length}**`,
    ...(deferred.length > 0
      ? ['', '### Deferred', ...deferred.map((f) => `- ${f}`)]
      : []),
    ...(stillConflicted.length > 0
      ? ['', '### Still conflicted', ...stillConflicted.map((f) => `- ${f}`)]
      : []),
  ]);

  if (stillConflicted.length > 0) {
    throw new Error(
      `Unresolved conflicts remain (${stillConflicted.length}): ${stillConflicted.join(', ')}. ` +
        (deferred.length > 0
          ? `${deferred.length} file(s) were deferred to save tokens — resolve in IDE or re-run with a higher AI_REPAIR_MAX_LLM_FILES.`
          : ''),
    );
  }

  console.log('All listed conflicts resolved in working tree.');
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
