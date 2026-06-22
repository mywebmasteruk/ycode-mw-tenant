import { execSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, extname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { inspectTenantSensitiveContent } from '../../lib/masjidweb/autopilot-tenant-invariants';
import {
  type PremiumAiResolvedFile,
  assertResolvedFileContent,
  assertResolvedFileTarget,
  decodePremiumAiContent,
} from '../../lib/masjidweb/premium-ai-patch';
import {
  DEFAULT_PREMIUM_AI_REPAIR_MODEL,
  type OpenRouterRepairResult,
  type OpenRouterUsage,
  assertBalancedDelimiters,
  assertNoConflictMarkers,
  requestOpenRouterRepair,
  resolveOpenRouterRepairModel,
  stripCodeFences,
} from '../../lib/masjidweb/openrouter-repair';
import { extractConflictHunks, replaceConflictHunk } from '../../lib/masjidweb/merge-conflict-hunks';

const REPO_ROOT = join(__dirname, '..', '..');
const REPORT_PATH = process.env.PREMIUM_AI_REPAIR_REPORT_PATH || '/tmp/premium-ai-repair-report.md';
const REPORT_JSON_PATH = process.env.PREMIUM_AI_REPAIR_REPORT_JSON_PATH || '/tmp/premium-ai-repair-report.json';
const AUTOPILOT_REPORT_PATH = process.env.AUTOPILOT_REPAIR_REPORT_PATH || '/tmp/autopilot-repair-report.md';
const AUTOPILOT_REPORT_JSON_PATH = process.env.AUTOPILOT_REPAIR_REPORT_JSON_PATH || '/tmp/autopilot-repair-report.json';
const REPAIR_BATCH_SIZE = parsePositiveInt(process.env.PREMIUM_AI_REPAIR_BATCH_SIZE, 1);
const MAX_FILE_CHARS = parsePositiveInt(process.env.PREMIUM_AI_REPAIR_MAX_FILE_CHARS, 60_000);
const MAX_RETRY_FILE_CHARS = parsePositiveInt(process.env.PREMIUM_AI_REPAIR_RETRY_MAX_FILE_CHARS, 40_000);
const MAX_HUNK_CONTEXT_LINES = parsePositiveInt(process.env.PREMIUM_AI_REPAIR_HUNK_CONTEXT_LINES, 80);
const MAX_DOC_CHARS = parsePositiveInt(process.env.PREMIUM_AI_REPAIR_MAX_DOC_CHARS, 12_000);
const MAX_REPLY_TOKENS = parsePositiveInt(process.env.PREMIUM_AI_REPAIR_MAX_TOKENS, 24_000);
const MAX_TARGET_FILES = Math.min(parsePositiveInt(process.env.PREMIUM_AI_REPAIR_MAX_FILES, 4), 4);
const MAX_TOTAL_MODEL_CALLS = parsePositiveInt(process.env.PREMIUM_AI_REPAIR_MAX_MODEL_CALLS, 8);
const MAX_CALL_MS = parsePositiveInt(process.env.PREMIUM_AI_REPAIR_MAX_CALL_MS, 180_000);
const MAX_TOTAL_MS = parsePositiveInt(process.env.PREMIUM_AI_REPAIR_MAX_TOTAL_MS, 900_000);
const MAX_TRUNCATED_OR_INVALID = parsePositiveInt(process.env.PREMIUM_AI_REPAIR_MAX_BAD_RESPONSES, 2);
const MAX_HUNKS_PER_FILE = parsePositiveInt(process.env.PREMIUM_AI_REPAIR_MAX_HUNKS_PER_FILE, 2);
const ENABLE_HUNK_FALLBACK = parseBool(process.env.PREMIUM_AI_REPAIR_ENABLE_HUNK_FALLBACK);
const HUGE_FILE_DENY_CHARS = parsePositiveInt(process.env.PREMIUM_AI_REPAIR_HUGE_FILE_DENY_CHARS, 180_000);
const PATCH_ARTIFACT_PATH = process.env.PREMIUM_AI_REPAIR_PATCH_PATH || '/tmp/premium-ai-repair-checkpoint.patch';
const CHECKPOINT_DIR = process.env.PREMIUM_AI_REPAIR_CHECKPOINT_DIR || '/tmp/premium-ai-checkpoints';

const TENANT_INVARIANT_DOCS = [
  'docs/masjidweb-core-seams.md',
  'docs/core-update-process.md',
  'docs/CURSOR_CORE_UPDATE_ESCALATION.md',
];

const SAFETY_RULES = [
  'Do not remove tenant filters or tenant_id checks.',
  'Do not bypass tenant_id validation to make a conflict disappear.',
  'Do not pass tenantId or any argument into getSupabaseAdmin().',
  'Preserve applyTenantEq, resolveEffectiveTenantId, and runWithEffectiveTenantId call paths.',
  'Never add service-role reads without tenant filters or documented tenant-owner joins.',
  'Do not auto-merge, approve, mark ready, or imply the pull request is safe.',
  'If safety cannot be proven from the supplied context, return blocked with no diff.',
];

type AutopilotReportJson = {
  blockedFiles?: string[];
  conflictFiles?: string[];
  actions?: Array<{ filePath?: string; outcome?: string; summary?: string; details?: string[] }>;
};

type PremiumAiFileAssessment = {
  filePath: string;
  verdict: 'blocked' | 'safe_candidate' | 'needs_human_review' | 'applied';
  summary: string;
  safetyConcerns: string[];
  unifiedDiff: string | null;
};

export type PremiumAiFileRepairStatus =
  | 'applied'
  | 'blocked'
  | 'model_truncated'
  | 'invalid_json'
  | 'invariant_failed'
  | 'hunk_fallback_applied'
  | 'checkpointed'
  | 'skipped';

export type PremiumAiFileRepairResult = {
  filePath: string;
  status: PremiumAiFileRepairStatus;
  summary: string;
  safetyConcerns: string[];
  applied: boolean;
  retryUsed: boolean;
  model: string;
  finishReason: string | null;
  usage: OpenRouterUsage | null;
  error: string | null;
};

type PremiumAiReportStatus =
  | 'blocked'
  | 'applied'
  | 'content_replacement_applied'
  | 'partial_failed'
  | 'no_conflicts'
  | 'model_failed'
  | 'patch_parse_failed'
  | 'patch_apply_failed';

type PremiumAiCheckpoint = {
  strategy: 'patch_artifact';
  persisted: boolean;
  patchPath: string | null;
  checkpointDir: string | null;
  files: string[];
  summary: string;
};

type PremiumAiReport = {
  status: PremiumAiReportStatus;
  mode: 'apply_repairs';
  model: string;
  generatedAt: string;
  repairBatchSize: number;
  conflictFiles: string[];
  blockedFiles: string[];
  appliedFiles: string[];
  unresolvedFiles: string[];
  checkpoint: PremiumAiCheckpoint;
  summary: string;
  files: PremiumAiFileAssessment[];
  fileResults: PremiumAiFileRepairResult[];
  metrics: PremiumAiRepairMetrics;
  nextActions: string[];
};

type PremiumAiRepairMetrics = {
  modelCalls: number;
  badResponses: number;
  promptTokens: number | null;
  completionTokens: number | null;
  totalTokens: number | null;
  cost: number | null;
  elapsedMs: number;
  stoppedReason: string | null;
};

type ParsedModelRepair = {
  summary: string;
  files: PremiumAiFileAssessment[];
  nextActions: string[];
  resolvedFiles: PremiumAiResolvedFile[];
};

type FileRepairAttempt = 'initial' | 'truncation_retry' | 'json_repair' | 'hunk';

type RepairFilesOneAtATimeArgs = {
  targetFiles: string[];
  blockedFiles: string[];
  requestFile: (filePath: string, attempt: FileRepairAttempt, promptOverride?: string) => Promise<OpenRouterRepairResult>;
  applyFile: (file: PremiumAiResolvedFile, allowedFiles: Set<string>) => string;
  validateFile: (filePath: string) => void;
  readFile?: (filePath: string) => string;
  enableHunkFallback?: boolean;
};

function parsePositiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseBool(value: string | undefined): boolean {
  return value === '1' || value === 'true' || value === 'yes';
}

function run(command: string): string {
  try {
    return execSync(command, { cwd: REPO_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  } catch (error) {
    const err = error as { stdout?: Buffer | string; stderr?: Buffer | string };
    return [err.stdout, err.stderr]
      .map((part) => (Buffer.isBuffer(part) ? part.toString('utf8') : part ?? ''))
      .filter(Boolean)
      .join('\n')
      .trim();
  }
}

function runOrThrow(command: string): string {
  return execSync(command, { cwd: REPO_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function listLines(command: string): string[] {
  return run(command)
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))].sort();
}

function listConflictFiles(): string[] {
  const unmerged = listLines('git diff --name-only --diff-filter=U');
  const markerFiles = listLines('git grep -l "^<<<<<<<" -- . ":(exclude)node_modules"');
  return uniqueSorted([...unmerged, ...markerFiles]);
}

function readIfExists(path: string, maxChars = MAX_DOC_CHARS): string {
  if (!existsSync(path)) return '';
  const value = readFileSync(path, 'utf8');
  if (value.length <= maxChars) return value;
  return `${value.slice(0, maxChars)}\n…(truncated to ${maxChars} chars)`;
}

function readRepoFile(path: string, maxChars = MAX_DOC_CHARS): string {
  return readIfExists(join(REPO_ROOT, path), maxChars);
}

function readAutopilotJson(): AutopilotReportJson | null {
  const raw = readIfExists(AUTOPILOT_REPORT_JSON_PATH, 300_000);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as AutopilotReportJson;
  } catch {
    return null;
  }
}

function blockedFilesFromAutopilot(report: AutopilotReportJson | null, conflictFiles: string[]): string[] {
  if (!report) return conflictFiles;
  const actionBlocked = (report.actions ?? [])
    .filter((action) => action.outcome === 'blocked' || action.outcome === 'failed')
    .map((action) => action.filePath ?? '');
  return uniqueSorted([...(report.blockedFiles ?? []), ...actionBlocked]);
}

function contextForConflictFile(filePath: string, maxFileChars = MAX_FILE_CHARS, includeStages = true): string {
  const content = readRepoFile(filePath, maxFileChars);
  const sections = [
    `## ${filePath}`,
    '',
    '### Working tree content with conflict markers',
    fenced(content || '(file missing or not readable)', extname(filePath)),
  ];

  if (includeStages) {
    const base = run(`git show :1:${JSON.stringify(filePath)}`);
    const ours = run(`git show :2:${JSON.stringify(filePath)}`);
    const theirs = run(`git show :3:${JSON.stringify(filePath)}`);
    if (base) sections.push('### Merge base excerpt', fenced(trimTo(base, 16_000), extname(filePath)));
    if (ours) sections.push('### Ours excerpt', fenced(trimTo(ours, 16_000), extname(filePath)));
    if (theirs) sections.push('### Theirs excerpt', fenced(trimTo(theirs, 16_000), extname(filePath)));
  }

  return sections.join('\n\n');
}

function trimTo(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, maxChars)}\n…(truncated to ${maxChars} chars)`;
}

function fenced(value: string, extension: string): string {
  const language = extension.replace(/^\./, '') || 'text';
  return ['```' + language, value, '```'].join('\n');
}

function requiredOutputSchema(): string {
  return '{ "summary": string, "files": [{ "filePath": string, "verdict": "blocked" | "safe_candidate" | "needs_human_review", "summary": string, "safetyConcerns": string[], "content": string | null, "contentBase64": string | null, "unifiedDiff": null }], "resolvedFiles": [{ "filePath": string, "content": string }], "patches": [], "nextActions": string[] }';
}

function tenantInvariantDocs(): string {
  return TENANT_INVARIANT_DOCS
    .map((path) => {
      const content = readRepoFile(path);
      return content ? `## ${path}\n\n${content}` : '';
    })
    .filter(Boolean)
    .join('\n\n');
}

function buildPromptForFile(filePath: string, conflictFiles: string[], blockedFiles: string[]): string {
  const autopilotMarkdown = readIfExists(AUTOPILOT_REPORT_PATH, 80_000);
  return [
    'MasjidWeb Premium AI Repair request for one file only.',
    '',
    `Target file: ${filePath}`,
    '',
    'Return strict resolved-file JSON for the target file only. The workflow will write the replacement only after validating path, conflict markers, delimiter balance, and tenant invariants.',
    '',
    'Safety rules:',
    ...SAFETY_RULES.map((rule) => `- ${rule}`),
    '',
    'Required output schema: return ONLY JSON, no markdown fences:',
    requiredOutputSchema(),
    '',
    'Resolved-file requirements:',
    '- Return exactly one resolvedFiles entry when safe, and it must be the complete final content for the target file.',
    '- Do not repair or mention replacements for any other file.',
    '- The complete content must contain no conflict markers and must not be truncated.',
    '- Use contentBase64 instead of content when escaping source text would be risky.',
    '- Do not return unified diffs. patches must be an empty array.',
    '- Use verdict "blocked" and omit resolvedFiles when tenant isolation cannot be proven.',
    '- Do not include prose outside JSON.',
    '',
    `Exact conflicted files in the repository: ${conflictFiles.join(', ') || '(none)'}`,
    `Exact blocked files from deterministic repair: ${blockedFiles.join(', ') || '(none)'}`,
    '',
    'Tenant invariant docs / summary:',
    tenantInvariantDocs() || 'Preserve MasjidWeb tenant isolation. Never remove tenant_id scoping.',
    '',
    'Autopilot report:',
    autopilotMarkdown || '(no Autopilot report artifact found)',
    '',
    'Target file context:',
    contextForConflictFile(filePath),
  ].join('\n');
}

function buildTruncationRetryPromptForFile(filePath: string): string {
  return [
    'The previous OpenRouter completion for this single file was truncated by the token limit.',
    '',
    `Target file: ${filePath}`,
    '',
    'Return ONLY valid JSON. Return exactly one complete resolvedFiles entry for the target file, or blocked with no resolvedFiles if unsafe.',
    'Do not include explanations, markdown, unified diffs, or repairs for any other file.',
    'Prefer contentBase64 if JSON escaping is risky.',
    '',
    'Required output schema:',
    requiredOutputSchema(),
    '',
    'Safety rules:',
    ...SAFETY_RULES.map((rule) => `- ${rule}`),
    '',
    'Target file context only:',
    contextForConflictFile(filePath, MAX_RETRY_FILE_CHARS, false),
  ].join('\n');
}

function buildJsonRepairPromptForFile(filePath: string, invalidReply: string): string {
  return [
    'The previous OpenRouter completion for this single file was not valid JSON.',
    '',
    `Target file: ${filePath}`,
    '',
    'Retry once. Return ONLY strict valid JSON for this target file. No markdown fences, no prose, no comments, no trailing commas.',
    'Return exactly one complete resolvedFiles entry for the target file, or blocked with no resolvedFiles if unsafe.',
    'Prefer contentBase64 if escaping source text would be risky.',
    '',
    'Required output schema:',
    requiredOutputSchema(),
    '',
    'Safety rules:',
    ...SAFETY_RULES.map((rule) => `- ${rule}`),
    '',
    'Invalid prior response excerpt:',
    fenced(trimTo(invalidReply, 8_000), '.txt'),
    '',
    'Target file context only:',
    contextForConflictFile(filePath, MAX_RETRY_FILE_CHARS, false),
  ].join('\n');
}

function hunkContext(content: string, hunk: string): string {
  const lines = content.split('\n');
  const hunkLines = hunk.split('\n');
  const hunkStartLine = lines.findIndex((_, index) => lines.slice(index, index + hunkLines.length).join('\n') === hunk);
  if (hunkStartLine === -1) return hunk;
  const start = Math.max(0, hunkStartLine - MAX_HUNK_CONTEXT_LINES);
  const end = Math.min(lines.length, hunkStartLine + hunkLines.length + MAX_HUNK_CONTEXT_LINES);
  return lines.slice(start, end).join('\n');
}

function buildHunkRepairPrompt(args: { filePath: string; fileContent: string; hunk: string; hunkIndex: number; hunkCount: number }): string {
  return [
    'The complete-file repair was truncated or unusable. Resolve exactly one merge-conflict hunk.',
    '',
    `Target file: ${args.filePath}`,
    `Hunk: ${args.hunkIndex + 1} of ${args.hunkCount}`,
    '',
    'Return ONLY strict JSON. The resolved hunk must replace exactly the supplied conflict hunk; do not return the whole file.',
    'If tenant safety cannot be proven from this hunk context, return blocked with resolvedHunk set to null.',
    '',
    'Required output schema: { "summary": string, "verdict": "safe_candidate" | "blocked", "safetyConcerns": string[], "resolvedHunk": string | null }',
    '',
    'Safety rules:',
    ...SAFETY_RULES.map((rule) => `- ${rule}`),
    '',
    'Conflict hunk to resolve:',
    fenced(args.hunk, extname(args.filePath)),
    '',
    'Nearby file context:',
    fenced(hunkContext(args.fileContent, args.hunk), extname(args.filePath)),
    '',
    'Tenant invariant docs / summary:',
    tenantInvariantDocs() || 'Preserve MasjidWeb tenant isolation. Never remove tenant_id scoping.',
  ].join('\n');
}

function parseJsonObject(raw: string): Record<string, unknown> {
  const stripped = stripCodeFences(raw);
  try {
    return JSON.parse(stripped) as Record<string, unknown>;
  } catch {
    const first = stripped.indexOf('{');
    const last = stripped.lastIndexOf('}');
    if (first === -1 || last === -1 || last <= first) throw new Error('No JSON object found in model response');
    return JSON.parse(stripped.slice(first, last + 1)) as Record<string, unknown>;
  }
}

function normalizeAssessment(entry: unknown): PremiumAiFileAssessment {
  const item = entry as Partial<PremiumAiFileAssessment>;
  const verdict =
    item.verdict === 'safe_candidate' || item.verdict === 'needs_human_review' || item.verdict === 'applied'
      ? item.verdict
      : 'blocked';
  return {
    filePath: typeof item.filePath === 'string' ? item.filePath : '(unknown)',
    verdict,
    summary: typeof item.summary === 'string' ? item.summary : 'No summary returned.',
    safetyConcerns: Array.isArray(item.safetyConcerns)
      ? item.safetyConcerns.filter((value): value is string => typeof value === 'string')
      : [],
    unifiedDiff: typeof item.unifiedDiff === 'string' && item.unifiedDiff.trim() ? item.unifiedDiff : null,
  };
}

function parseResolvedFile(entry: unknown): PremiumAiResolvedFile | null {
  const item = entry as { filePath?: unknown };
  if (typeof item.filePath !== 'string') return null;
  const filePath = item.filePath.trim();
  const content = decodePremiumAiContent(entry);
  if (!filePath || content === null) return null;
  return { filePath, content };
}

function parseModelRepair(raw: string): ParsedModelRepair {
  const parsed = parseJsonObject(raw);
  const files = Array.isArray(parsed.files) ? parsed.files.map(normalizeAssessment) : [];
  const explicitResolvedFiles = Array.isArray(parsed.resolvedFiles)
    ? parsed.resolvedFiles.map(parseResolvedFile).filter((file): file is PremiumAiResolvedFile => Boolean(file))
    : [];
  const fileResolvedFiles = Array.isArray(parsed.files)
    ? parsed.files.map(parseResolvedFile).filter((file): file is PremiumAiResolvedFile => Boolean(file))
    : [];
  return {
    summary: typeof parsed.summary === 'string' ? parsed.summary : 'Premium AI returned repair guidance.',
    files,
    nextActions: Array.isArray(parsed.nextActions)
      ? parsed.nextActions.filter((value): value is string => typeof value === 'string')
      : ['Review workflow logs and rerun Premium AI Repair or repair manually.'],
    resolvedFiles: [...explicitResolvedFiles, ...fileResolvedFiles],
  };
}

function uniqueResolvedFiles(files: PremiumAiResolvedFile[]): PremiumAiResolvedFile[] {
  return files.filter((file, index, list) =>
    list.findIndex((other) => other.filePath === file.filePath && other.content === file.content) === index,
  );
}

type ParsedHunkRepair = {
  summary: string;
  verdict: 'safe_candidate' | 'blocked';
  safetyConcerns: string[];
  resolvedHunk: string | null;
};

function parseHunkRepair(raw: string): ParsedHunkRepair {
  const parsed = parseJsonObject(raw) as {
    summary?: unknown;
    verdict?: unknown;
    safetyConcerns?: unknown;
    resolvedHunk?: unknown;
  };
  return {
    summary: typeof parsed.summary === 'string' ? parsed.summary : 'Premium AI returned hunk repair guidance.',
    verdict: parsed.verdict === 'safe_candidate' ? 'safe_candidate' : 'blocked',
    safetyConcerns: Array.isArray(parsed.safetyConcerns)
      ? parsed.safetyConcerns.filter((value): value is string => typeof value === 'string')
      : [],
    resolvedHunk: typeof parsed.resolvedHunk === 'string' ? parsed.resolvedHunk : null,
  };
}

function validateResolvedFileContent(filePath: string, content: string): void {
  assertResolvedFileContent({ filePath, content });
  assertNoConflictMarkers(content, filePath);
  assertBalancedDelimiters(content, filePath);
  const invariantFailures = inspectTenantSensitiveContent(filePath, content);
  if (invariantFailures.length > 0) {
    throw new Error(`Tenant invariant failures after Premium AI patch in ${filePath}: ${invariantFailures.join('; ')}`);
  }
}

function applyResolvedFile(file: PremiumAiResolvedFile, allowedFiles: Set<string>): string {
  const filePath = assertResolvedFileTarget(file, allowedFiles);
  const content = file.content.endsWith('\n') ? file.content : `${file.content}\n`;
  validateResolvedFileContent(filePath, content);
  writeFileSync(join(REPO_ROOT, filePath), content);
  return filePath;
}

function validateRepairedFile(filePath: string): void {
  const absolutePath = join(REPO_ROOT, filePath);
  if (!existsSync(absolutePath)) throw new Error(`Repaired file is missing: ${filePath}`);
  const content = readFileSync(absolutePath, 'utf8');
  validateResolvedFileContent(filePath, content);
}

function isHugeFile(filePath: string): boolean {
  const content = readRepoFile(filePath, Number.MAX_SAFE_INTEGER);
  return content.length > HUGE_FILE_DENY_CHARS;
}

function filterEligibleTargetFiles(conflictFiles: string[]): { targetFiles: string[]; skippedFiles: string[] } {
  const eligible = conflictFiles.filter((file) => !isHugeFile(file));
  return {
    targetFiles: eligible.slice(0, MAX_TARGET_FILES),
    skippedFiles: [...eligible.slice(MAX_TARGET_FILES), ...conflictFiles.filter(isHugeFile)],
  };
}

function stageRepairedFiles(files: string[]): void {
  for (const file of files) {
    runOrThrow(`git add -- ${JSON.stringify(file)}`);
  }
}

function emptyCheckpoint(summary: string): PremiumAiCheckpoint {
  return {
    strategy: 'patch_artifact',
    persisted: false,
    patchPath: null,
    checkpointDir: null,
    files: [],
    summary,
  };
}

function patchArtifactPath(): string {
  return process.env.PREMIUM_AI_REPAIR_PATCH_PATH || PATCH_ARTIFACT_PATH;
}

function checkpointDir(): string {
  return process.env.PREMIUM_AI_REPAIR_CHECKPOINT_DIR || CHECKPOINT_DIR;
}

function createCheckpointForAppliedFiles(appliedFiles: string[], unresolvedFiles: string[], repoRoot = REPO_ROOT): PremiumAiCheckpoint {
  if (appliedFiles.length === 0) {
    return emptyCheckpoint('No safe partial repairs were available to persist.');
  }

  for (const file of appliedFiles) {
    const content = readFileSync(join(repoRoot, file), 'utf8');
    validateResolvedFileContent(file, content);
  }

  const patchPath = patchArtifactPath();
  const checkpointBaseDir = checkpointDir();
  mkdirSync(dirname(patchPath), { recursive: true });
  mkdirSync(checkpointBaseDir, { recursive: true });
  const checkpointRoot = mkdtempSync(join(checkpointBaseDir, 'premium-ai-'));

  for (const file of appliedFiles) {
    const target = join(checkpointRoot, file);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, readFileSync(join(repoRoot, file), 'utf8'));
  }

  const tempRoot = mkdtempSync(join(tmpdir(), 'premium-ai-checkpoint-'));
  try {
    execSync(`git archive HEAD ${appliedFiles.map((file) => JSON.stringify(file)).join(' ')} | tar -x -C ${JSON.stringify(tempRoot)}`, {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    for (const file of appliedFiles) {
      writeFileSync(join(tempRoot, file), readFileSync(join(repoRoot, file), 'utf8'));
    }
    execSync('git diff --no-index --binary . ' + JSON.stringify(tempRoot), {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    writeFileSync(patchPath, '');
  } catch (error) {
    const err = error as { stdout?: Buffer | string; status?: number };
    const stdout = Buffer.isBuffer(err.stdout) ? err.stdout.toString('utf8') : err.stdout ?? '';
    if (stdout.trim()) {
      writeFileSync(patchPath, stdout.replaceAll(`${tempRoot}/`, ''));
    } else if (err.status !== 1) {
      throw error;
    } else {
      writeFileSync(patchPath, '');
    }
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }

  for (const file of unresolvedFiles) {
    execSync(`git reset -q -- ${JSON.stringify(file)}`, { cwd: repoRoot, stdio: 'ignore' });
    execSync(`git checkout -f HEAD -- ${JSON.stringify(file)}`, { cwd: repoRoot, stdio: 'ignore' });
  }
  for (const file of appliedFiles) {
    execSync(`git add -- ${JSON.stringify(file)}`, { cwd: repoRoot, stdio: 'ignore' });
  }

  return {
    strategy: 'patch_artifact',
    persisted: true,
    patchPath,
    checkpointDir: checkpointRoot,
    files: appliedFiles,
    summary: `Persisted ${appliedFiles.length} safe partial repair(s) as a patch artifact. Unresolved files were restored from HEAD so this branch remains committable and the next run can target only remaining conflicts after reapplying the artifact.`,
  };
}

function setGithubOutput(name: string, value: string): void {
  const outputPath = process.env.GITHUB_OUTPUT;
  if (!outputPath) return;
  appendFileSync(outputPath, `${name}=${value.replaceAll('\n', ' ')}\n`);
}

function isTruncationError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes('finish_reason=length') || message.toLowerCase().includes('response was truncated');
}

function fileResult(args: {
  filePath: string;
  status: PremiumAiFileRepairStatus;
  summary: string;
  safetyConcerns?: string[];
  applied?: boolean;
  retryUsed?: boolean;
  model?: string;
  finishReason?: string | null;
  usage?: OpenRouterUsage | null;
  error?: string | null;
}): PremiumAiFileRepairResult {
  return {
    filePath: args.filePath,
    status: args.status,
    summary: args.summary,
    safetyConcerns: args.safetyConcerns ?? [],
    applied: args.applied ?? false,
    retryUsed: args.retryUsed ?? false,
    model: args.model ?? '',
    finishReason: args.finishReason ?? null,
    usage: args.usage ?? null,
    error: args.error ?? null,
  };
}

function classifyApplicationError(error: unknown): PremiumAiFileRepairStatus {
  if (isTruncationError(error)) return 'model_truncated';
  return 'invariant_failed';
}

function modelErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function requestAndParseFileRepair(args: {
  filePath: string;
  requestFile: RepairFilesOneAtATimeArgs['requestFile'];
  attempt: FileRepairAttempt;
  promptOverride?: string;
}): Promise<{ result: OpenRouterRepairResult; parsed: ParsedModelRepair }> {
  const result = await args.requestFile(args.filePath, args.attempt, args.promptOverride);
  return { result, parsed: parseModelRepair(result.reply) };
}

async function repairSingleFile(args: {
  filePath: string;
  blockedFiles: string[];
  requestFile: RepairFilesOneAtATimeArgs['requestFile'];
  applyFile: RepairFilesOneAtATimeArgs['applyFile'];
  validateFile: RepairFilesOneAtATimeArgs['validateFile'];
  readFile?: RepairFilesOneAtATimeArgs['readFile'];
  enableHunkFallback: boolean;
}): Promise<{ result: PremiumAiFileRepairResult; assessments: PremiumAiFileAssessment[]; appliedFiles: string[] }> {
  let retryUsed = false;

  async function attemptRepair(attempt: FileRepairAttempt, promptOverride?: string): Promise<{ result: PremiumAiFileRepairResult; assessments: PremiumAiFileAssessment[]; appliedFiles: string[] }> {
    const { result, parsed } = await requestAndParseFileRepair({ filePath: args.filePath, requestFile: args.requestFile, attempt, promptOverride });
    const allowedFiles = new Set([args.filePath]);
    const resolvedFiles = uniqueResolvedFiles(parsed.resolvedFiles).filter((file) => file.filePath === args.filePath);
    const assessmentConcerns = parsed.files.flatMap((file) => file.filePath === args.filePath ? file.safetyConcerns : []);

    if (resolvedFiles.length === 0) {
      return {
        result: fileResult({
          filePath: args.filePath,
          status: 'blocked',
          summary: parsed.summary || 'Premium AI did not return a complete replacement for this file.',
          safetyConcerns: assessmentConcerns,
          retryUsed,
          model: result.model,
          finishReason: result.finishReason,
          usage: result.usage ?? null,
        }),
        assessments: parsed.files,
        appliedFiles: [],
      };
    }

    try {
      const appliedFiles = uniqueSorted(resolvedFiles.map((file) => args.applyFile(file, allowedFiles)));
      for (const file of appliedFiles) {
        args.validateFile(file);
      }
      return {
        result: fileResult({
          filePath: args.filePath,
          status: attempt === 'hunk' ? 'hunk_fallback_applied' : 'applied',
          summary: parsed.summary || 'Premium AI returned a validated file replacement.',
          safetyConcerns: assessmentConcerns,
          applied: true,
          retryUsed,
          model: result.model,
          finishReason: result.finishReason,
          usage: result.usage ?? null,
        }),
        assessments: parsed.files.map((file) =>
          appliedFiles.includes(file.filePath) ? { ...file, verdict: 'applied' as const } : file,
        ),
        appliedFiles,
      };
    } catch (error) {
      const status = classifyApplicationError(error);
      return {
        result: fileResult({
          filePath: args.filePath,
          status,
          summary: `Premium AI replacement was rejected for this file: ${modelErrorMessage(error)}`,
          safetyConcerns: assessmentConcerns,
          retryUsed,
          model: result.model,
          finishReason: result.finishReason,
          usage: result.usage ?? null,
          error: modelErrorMessage(error),
        }),
        assessments: parsed.files,
        appliedFiles: [],
      };
    }
  }

  async function attemptJsonRepair(invalidReply: string): Promise<{ result: PremiumAiFileRepairResult; assessments: PremiumAiFileAssessment[]; appliedFiles: string[] }> {
    retryUsed = true;
    try {
      return await attemptRepair('json_repair', buildJsonRepairPromptForFile(args.filePath, invalidReply));
    } catch (error) {
      return {
        result: fileResult({
          filePath: args.filePath,
          status: 'invalid_json',
          summary: `Premium AI JSON repair retry was not usable for this file: ${modelErrorMessage(error)}`,
          retryUsed,
          error: modelErrorMessage(error),
        }),
        assessments: [],
        appliedFiles: [],
      };
    }
  }

  async function attemptHunkFallback(): Promise<{ result: PremiumAiFileRepairResult; assessments: PremiumAiFileAssessment[]; appliedFiles: string[] }> {
    retryUsed = true;
    const originalContent = args.readFile ? args.readFile(args.filePath) : readRepoFile(args.filePath, Number.MAX_SAFE_INTEGER);
    const hunks = extractConflictHunks(originalContent);
    if (hunks.length === 0) {
      return {
        result: fileResult({
          filePath: args.filePath,
          status: 'model_truncated',
          summary: 'Premium AI full-file repair was truncated, and no conflict hunks were available for fallback.',
          retryUsed,
        }),
        assessments: [],
        appliedFiles: [],
      };
    }
    if (!args.enableHunkFallback) {
      return {
        result: fileResult({
          filePath: args.filePath,
          status: 'model_truncated',
          summary: 'Premium AI full-file repair was truncated twice. Hunk fallback is disabled by default to prevent extra token spend on tenant-sensitive files; repair manually or rerun with PREMIUM_AI_REPAIR_ENABLE_HUNK_FALLBACK=true after changing strategy.',
          retryUsed,
        }),
        assessments: [],
        appliedFiles: [],
      };
    }
    if (hunks.length > MAX_HUNKS_PER_FILE) {
      return {
        result: fileResult({
          filePath: args.filePath,
          status: 'model_truncated',
          summary: `Premium AI full-file repair was truncated twice. Hunk fallback refused ${hunks.length} hunks (cap ${MAX_HUNKS_PER_FILE}) to prevent runaway model calls.`,
          retryUsed,
        }),
        assessments: [],
        appliedFiles: [],
      };
    }

    let nextContent = originalContent;
    const safetyConcerns: string[] = [];
    const summaries: string[] = [];
    let model = '';
    let finishReason: string | null = null;

    for (let index = 0; index < hunks.length; index += 1) {
      const hunk = hunks[index];
      const prompt = buildHunkRepairPrompt({
        filePath: args.filePath,
        fileContent: nextContent,
        hunk,
        hunkIndex: index,
        hunkCount: hunks.length,
      });
      try {
        const result = await args.requestFile(args.filePath, 'hunk', prompt);
        model = result.model;
        finishReason = result.finishReason;
        const parsed = parseHunkRepair(result.reply);
        safetyConcerns.push(...parsed.safetyConcerns);
        summaries.push(parsed.summary);
        if (parsed.verdict !== 'safe_candidate' || parsed.resolvedHunk === null) {
          return {
            result: fileResult({
              filePath: args.filePath,
              status: 'blocked',
              summary: `Premium AI hunk fallback blocked hunk ${index + 1}: ${parsed.summary}`,
              safetyConcerns,
              retryUsed,
              model,
              finishReason,
            }),
            assessments: [],
            appliedFiles: [],
          };
        }
        assertNoConflictMarkers(parsed.resolvedHunk, `${args.filePath} hunk ${index + 1}`);
        nextContent = replaceConflictHunk(nextContent, hunk, parsed.resolvedHunk);
      } catch (error) {
        const status: PremiumAiFileRepairStatus = isTruncationError(error) ? 'model_truncated' : 'invalid_json';
        return {
          result: fileResult({
            filePath: args.filePath,
            status,
            summary: `Premium AI hunk fallback failed for hunk ${index + 1}: ${modelErrorMessage(error)}`,
            safetyConcerns,
            retryUsed,
            model,
            finishReason,
            error: modelErrorMessage(error),
          }),
          assessments: [],
          appliedFiles: [],
        };
      }
    }

    try {
      const appliedFile = args.applyFile({ filePath: args.filePath, content: nextContent }, new Set([args.filePath]));
      args.validateFile(appliedFile);
      return {
        result: fileResult({
          filePath: args.filePath,
          status: 'hunk_fallback_applied',
          summary: `Resolved ${hunks.length} conflict hunk(s): ${summaries.join(' ')}`.trim(),
          safetyConcerns,
          applied: true,
          retryUsed,
          model,
          finishReason,
        }),
        assessments: [{
          filePath: args.filePath,
          verdict: 'applied',
          summary: summaries.join(' ') || 'Premium AI hunk fallback produced a validated file replacement.',
          safetyConcerns,
          unifiedDiff: null,
        }],
        appliedFiles: [appliedFile],
      };
    } catch (error) {
      return {
        result: fileResult({
          filePath: args.filePath,
          status: classifyApplicationError(error),
          summary: `Premium AI hunk fallback file reconstruction was rejected: ${modelErrorMessage(error)}`,
          safetyConcerns,
          retryUsed,
          model,
          finishReason,
          error: modelErrorMessage(error),
        }),
        assessments: [],
        appliedFiles: [],
      };
    }
  }

  try {
    return await attemptRepair('initial');
  } catch (error) {
    if (!isTruncationError(error)) {
      return attemptJsonRepair(modelErrorMessage(error));
    }
  }

  retryUsed = true;
  try {
    return await attemptRepair('truncation_retry');
  } catch (error) {
    if (isTruncationError(error)) {
      return attemptHunkFallback();
    }
    return attemptJsonRepair(modelErrorMessage(error));
  }
}

export { createCheckpointForAppliedFiles };

export async function repairFilesOneAtATime(args: RepairFilesOneAtATimeArgs): Promise<{
  results: PremiumAiFileRepairResult[];
  assessments: PremiumAiFileAssessment[];
  appliedFiles: string[];
}> {
  const results: PremiumAiFileRepairResult[] = [];
  const assessments: PremiumAiFileAssessment[] = [];
  const appliedFiles: string[] = [];
  let badResponses = 0;

  for (const filePath of args.targetFiles) {
    const repaired = await repairSingleFile({
      filePath,
      blockedFiles: args.blockedFiles,
      requestFile: args.requestFile,
      applyFile: args.applyFile,
      validateFile: args.validateFile,
      readFile: args.readFile,
      enableHunkFallback: args.enableHunkFallback ?? false,
    });
    results.push(repaired.result);
    assessments.push(...repaired.assessments);
    appliedFiles.push(...repaired.appliedFiles);

    if (repaired.result.status === 'model_truncated' || repaired.result.status === 'invalid_json') {
      badResponses += 1;
      if (badResponses >= MAX_TRUNCATED_OR_INVALID) {
        break;
      }
    }
  }

  return { results, assessments, appliedFiles: uniqueSorted(appliedFiles) };
}

function formatMarkdown(report: PremiumAiReport): string {
  const lines = [
    '# Premium AI Repair report',
    '',
    `Status: ${report.status}`,
    `Mode: ${report.mode}`,
    `Model: ${report.model}`,
    `Generated: ${report.generatedAt}`,
    `Repair batch size: ${report.repairBatchSize}`,
    '',
    report.summary,
    '',
    '## Safety posture',
    '',
    report.status === 'applied' || report.status === 'content_replacement_applied'
      ? 'Premium AI repairs were applied one file at a time, staged only after every target file passed validation, and remain subject to workflow verification and normal PR CI.'
      : report.checkpoint.persisted
        ? 'Premium AI did not complete the whole repair, but individually safe files were checkpointed as a durable patch artifact after per-file validation. Approval must stay blocked until remaining files are repaired and full PR CI is green.'
        : 'Premium AI did not leave a committable complete repair. Any applied working-tree changes remain unstaged for inspection, and approval must stay blocked.',
    '',
    '## Partial checkpoint',
    '',
    `- Persisted: ${report.checkpoint.persisted ? 'yes' : 'no'}`,
    `- Strategy: ${report.checkpoint.strategy}`,
    `- Patch artifact: ${report.checkpoint.patchPath ?? 'none'}`,
    `- Checkpoint directory: ${report.checkpoint.checkpointDir ?? 'none'}`,
    `- Summary: ${report.checkpoint.summary}`,
    '',
    '## Applied files',
    '',
    report.appliedFiles.length > 0 ? report.appliedFiles.map((file) => `- ${file}`).join('\n') : '- None',
    '',
    '## Token and runtime budget',
    '',
    `- Model calls: ${report.metrics.modelCalls}`,
    `- Bad responses: ${report.metrics.badResponses}`,
    `- Prompt tokens: ${report.metrics.promptTokens ?? 'not reported'}`,
    `- Completion tokens: ${report.metrics.completionTokens ?? 'not reported'}`,
    `- Total tokens: ${report.metrics.totalTokens ?? 'not reported'}`,
    `- Cost: ${report.metrics.cost === null ? 'not reported' : `$${report.metrics.cost.toFixed(6)}`}`,
    `- Elapsed: ${Math.round(report.metrics.elapsedMs / 1000)}s`,
    `- Stop reason: ${report.metrics.stoppedReason ?? 'none'}`,
    '',
    '## Unresolved files',
    '',
    report.unresolvedFiles.length > 0 ? report.unresolvedFiles.map((file) => `- ${file}`).join('\n') : '- None',
    '',
    '## Per-file repair results',
    '',
  ];

  if (report.fileResults.length === 0) {
    lines.push('- No per-file repair results were recorded.');
  }

  for (const result of report.fileResults) {
    lines.push(`### ${result.filePath}`, '', `- Status: **${result.status}**`, `- Applied: ${result.applied ? 'yes' : 'no'}`, `- Retry used: ${result.retryUsed ? 'yes' : 'no'}`);
    if (result.model) lines.push(`- Model: ${result.model}`);
    if (result.finishReason) lines.push(`- Finish reason: ${result.finishReason}`);
    lines.push(`- Summary: ${result.summary}`);
    if (result.error) lines.push(`- Error: ${result.error}`);
    if (result.safetyConcerns.length > 0) {
      lines.push('- Safety concerns:', ...result.safetyConcerns.map((concern) => `  - ${concern}`));
    }
    lines.push('');
  }

  lines.push('## Model assessments', '');
  if (report.files.length === 0) {
    lines.push('- No file assessments returned.');
  }

  for (const file of report.files) {
    lines.push(`### ${file.filePath}`, '', `- Verdict: **${file.verdict}**`, `- Summary: ${file.summary}`);
    if (file.safetyConcerns.length > 0) {
      lines.push('- Safety concerns:', ...file.safetyConcerns.map((concern) => `  - ${concern}`));
    }
    if (file.unifiedDiff) {
      lines.push('', '<details><summary>Unified diff</summary>', '', '```diff', file.unifiedDiff, '```', '', '</details>');
    }
    lines.push('');
  }

  lines.push('## Next actions', '', ...report.nextActions.map((action) => `- ${action}`), '');
  return lines.join('\n');
}

function emptyMetrics(elapsedMs = 0, stoppedReason: string | null = null): PremiumAiRepairMetrics {
  return {
    modelCalls: 0,
    badResponses: 0,
    promptTokens: null,
    completionTokens: null,
    totalTokens: null,
    cost: null,
    elapsedMs,
    stoppedReason,
  };
}

function addUsage(metrics: PremiumAiRepairMetrics, usage: OpenRouterUsage | null | undefined): void {
  if (!usage) return;
  if (typeof usage.prompt_tokens === 'number') {
    metrics.promptTokens = (metrics.promptTokens ?? 0) + usage.prompt_tokens;
  }
  if (typeof usage.completion_tokens === 'number') {
    metrics.completionTokens = (metrics.completionTokens ?? 0) + usage.completion_tokens;
  }
  if (typeof usage.total_tokens === 'number') {
    metrics.totalTokens = (metrics.totalTokens ?? 0) + usage.total_tokens;
  }
  if (typeof usage.cost === 'number') {
    metrics.cost = (metrics.cost ?? 0) + usage.cost;
  }
}

function writeReports(report: PremiumAiReport): void {
  mkdirSync(dirname(REPORT_JSON_PATH), { recursive: true });
  mkdirSync(dirname(REPORT_PATH), { recursive: true });
  writeFileSync(REPORT_JSON_PATH, `${JSON.stringify(report, null, 2)}\n`);
  const markdown = formatMarkdown(report);
  writeFileSync(REPORT_PATH, markdown);
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, markdown);
  }
  setGithubOutput('status', report.status);
  setGithubOutput('applied_count', String(report.appliedFiles.length));
  setGithubOutput('checkpoint_persisted', report.checkpoint.persisted ? 'true' : 'false');
  setGithubOutput('checkpoint_count', String(report.checkpoint.files.length));
  setGithubOutput('unresolved_count', String(report.unresolvedFiles.length));
  console.log(markdown);
}

function baseReport(args: {
  status: PremiumAiReportStatus;
  model: string;
  conflictFiles: string[];
  blockedFiles: string[];
  appliedFiles?: string[];
  unresolvedFiles?: string[];
  checkpoint?: PremiumAiCheckpoint;
  summary: string;
  files?: PremiumAiFileAssessment[];
  fileResults?: PremiumAiFileRepairResult[];
  metrics?: PremiumAiRepairMetrics;
  nextActions?: string[];
}): PremiumAiReport {
  return {
    status: args.status,
    mode: 'apply_repairs',
    model: args.model,
    generatedAt: new Date().toISOString(),
    repairBatchSize: REPAIR_BATCH_SIZE,
    conflictFiles: args.conflictFiles,
    blockedFiles: args.blockedFiles,
    appliedFiles: args.appliedFiles ?? [],
    unresolvedFiles: args.unresolvedFiles ?? [],
    checkpoint: args.checkpoint ?? emptyCheckpoint('No checkpoint was created.'),
    summary: args.summary,
    files: args.files ?? [],
    fileResults: args.fileResults ?? [],
    metrics: args.metrics ?? emptyMetrics(),
    nextActions: args.nextActions ?? ['Leave this update blocked until repaired and verified.'],
  };
}

function assertCompleteRepair(results: PremiumAiFileRepairResult[], targetFiles: string[]): void {
  const missing = targetFiles.filter((file) => !results.some((result) => result.filePath === file));
  const failed = results.filter((result) => !result.applied);
  if (missing.length > 0 || failed.length > 0) {
    const failedSummary = failed.map((result) => `${result.filePath}: ${result.status}`).join(', ');
    const missingSummary = missing.length > 0 ? ` Missing results: ${missing.join(', ')}.` : '';
    throw new Error(`Premium AI did not safely repair every target file.${failedSummary ? ` Failed files: ${failedSummary}.` : ''}${missingSummary}`);
  }
}

async function main(): Promise<void> {
  const conflictFiles = listConflictFiles();
  const autopilotJson = readAutopilotJson();
  const blockedFiles = blockedFilesFromAutopilot(autopilotJson, conflictFiles);
  const requestedModel = process.env.OPENROUTER_REPAIR_MODEL?.trim() || process.env.OPENROUTER_MODEL?.trim() || DEFAULT_PREMIUM_AI_REPAIR_MODEL;

  if (conflictFiles.length === 0) {
    writeReports(baseReport({
      status: 'no_conflicts',
      model: requestedModel,
      conflictFiles,
      blockedFiles,
      summary: 'No conflicted files or conflict markers were found, so Premium AI Repair had nothing to apply.',
      nextActions: ['Continue normal CI, preview, and approval gates.'],
    }));
    return;
  }

  const apiKey = process.env.OPENROUTER_API_KEY?.trim();
  if (!apiKey) {
    throw new Error('OPENROUTER_API_KEY is not set. Add it as a GitHub Actions secret before using Premium AI Repair.');
  }
  if (!apiKey.startsWith('sk-or-') && !apiKey.startsWith('sk-')) {
    throw new Error('OPENROUTER_API_KEY looks invalid. Set a real OpenRouter key as a GitHub Actions secret.');
  }

  const model = await resolveOpenRouterRepairModel({ apiKey, requestedModel });
  const startedAt = Date.now();
  const metrics = emptyMetrics();
  const { targetFiles, skippedFiles } = filterEligibleTargetFiles(conflictFiles);
  const requestFile = async (filePath: string, attempt: FileRepairAttempt, promptOverride?: string): Promise<OpenRouterRepairResult> => {
    if (metrics.stoppedReason) {
      throw new Error(metrics.stoppedReason);
    }
    if (metrics.modelCalls >= MAX_TOTAL_MODEL_CALLS) {
      metrics.stoppedReason = `model-call cap reached (${MAX_TOTAL_MODEL_CALLS})`;
      throw new Error(metrics.stoppedReason);
    }
    const elapsed = Date.now() - startedAt;
    if (elapsed > MAX_TOTAL_MS) {
      metrics.stoppedReason = `overall runtime cap reached (${Math.round(MAX_TOTAL_MS / 1000)}s)`;
      throw new Error(metrics.stoppedReason);
    }
    metrics.modelCalls += 1;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), MAX_CALL_MS);
    try {
      const result = await requestOpenRouterRepair({
        apiKey,
        model,
        messages: [
          {
            role: 'system',
            content: [
              'You are a frontier-model code repair agent for MasjidWeb core-update merge conflicts.',
              'Repair exactly one target file per request.',
              'Return only valid JSON using complete resolved file contents. Do not return unified diffs.',
              'Generate safe repairs only when tenant invariants are preserved.',
              ...SAFETY_RULES,
            ].join('\n'),
          },
          { role: 'user', content: promptOverride ?? (attempt === 'truncation_retry' ? buildTruncationRetryPromptForFile(filePath) : buildPromptForFile(filePath, conflictFiles, blockedFiles)) },
        ],
        maxTokens: MAX_REPLY_TOKENS,
        signal: controller.signal,
      }, 1);
      addUsage(metrics, result.usage);
      return result;
    } catch (error) {
      if (isTruncationError(error) || modelErrorMessage(error).includes('JSON')) {
        metrics.badResponses += 1;
        if (metrics.badResponses >= MAX_TRUNCATED_OR_INVALID) {
          metrics.stoppedReason = `bad-response cap reached (${MAX_TRUNCATED_OR_INVALID})`;
        }
      }
      throw error;
    } finally {
      clearTimeout(timeout);
      metrics.elapsedMs = Date.now() - startedAt;
    }
  };

  const aggregate = await repairFilesOneAtATime({
    targetFiles,
    blockedFiles,
    requestFile,
    applyFile: applyResolvedFile,
    validateFile: validateRepairedFile,
    enableHunkFallback: ENABLE_HUNK_FALLBACK,
  });

  try {
    assertCompleteRepair(aggregate.results, conflictFiles);
    stageRepairedFiles(aggregate.appliedFiles);
    metrics.elapsedMs = Date.now() - startedAt;
    writeReports(baseReport({
      status: 'content_replacement_applied',
      model,
      conflictFiles,
      blockedFiles,
      appliedFiles: aggregate.appliedFiles,
      unresolvedFiles: skippedFiles,
      summary: `Premium AI repaired ${aggregate.appliedFiles.length} file(s), one file per model request. All target files passed local replacement validation before staging.`,
      files: aggregate.assessments,
      fileResults: aggregate.results,
      metrics,
      nextActions: [
        'Run completeness, Autopilot guard, tenant isolation, type-check, build, and normal PR CI before approval.',
        'Do not treat Premium AI completion as merge approval.',
      ],
    }));
  } catch (error) {
    const message = modelErrorMessage(error);
    metrics.elapsedMs = Date.now() - startedAt;
    if (!metrics.stoppedReason && metrics.badResponses >= MAX_TRUNCATED_OR_INVALID) {
      metrics.stoppedReason = `bad-response cap reached (${MAX_TRUNCATED_OR_INVALID})`;
    }
    const unresolvedFiles = uniqueSorted([
      ...targetFiles.filter((file) => !aggregate.results.some((result) => result.filePath === file && result.applied)),
      ...skippedFiles,
    ]);
    const checkpoint = createCheckpointForAppliedFiles(aggregate.appliedFiles, unresolvedFiles);
    writeReports(baseReport({
      status: 'partial_failed',
      model,
      conflictFiles,
      blockedFiles,
      appliedFiles: aggregate.appliedFiles,
      unresolvedFiles,
      checkpoint,
      summary: `Premium AI failed after ${metrics.modelCalls} model call(s) across ${aggregate.results.length}/${conflictFiles.length} file(s): ${message}. No more retries are recommended until the strategy changes or a developer manually resolves the remaining tenant-sensitive files.`,
      files: aggregate.assessments,
      fileResults: aggregate.results,
      metrics,
      nextActions: [
        checkpoint.persisted
          ? 'Download and inspect the partial checkpoint artifact, but do not rerun Premium AI blindly; first change strategy or repair manually.'
          : 'No partial checkpoint was created because no file passed all per-file safety gates.',
        'Resolve remaining tenant-sensitive conflicts manually or with a hunk-level strategy that has explicit reviewer approval.',
        'Keep approval blocked until remaining files are repaired, branch-wide checks pass, and normal PR CI is green.',
      ],
    }));
    throw error;
  }
}

if (process.env.NODE_ENV !== 'test') {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
