import { appendFileSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, extname, join } from 'node:path';
import { execSync } from 'node:child_process';
import { inspectTenantSensitiveContent } from '../../lib/masjidweb/autopilot-tenant-invariants';
import {
  type PremiumAiPatch,
  type PremiumAiResolvedFile,
  assertPatchTargets,
  assertResolvedFileContent,
  assertResolvedFileTarget,
  decodePremiumAiContent,
  filesMentionedInDiff,
} from '../../lib/masjidweb/premium-ai-patch';
import {
  DEFAULT_PREMIUM_AI_REPAIR_MODEL,
  type OpenRouterRepairResult,
  assertBalancedDelimiters,
  assertNoConflictMarkers,
  requestOpenRouterRepair,
  resolveOpenRouterRepairModel,
  stripCodeFences,
} from '../../lib/masjidweb/openrouter-repair';

const REPO_ROOT = join(__dirname, '..', '..');
const REPORT_PATH = process.env.PREMIUM_AI_REPAIR_REPORT_PATH || '/tmp/premium-ai-repair-report.md';
const REPORT_JSON_PATH = process.env.PREMIUM_AI_REPAIR_REPORT_JSON_PATH || '/tmp/premium-ai-repair-report.json';
const AUTOPILOT_REPORT_PATH = process.env.AUTOPILOT_REPAIR_REPORT_PATH || '/tmp/autopilot-repair-report.md';
const AUTOPILOT_REPORT_JSON_PATH = process.env.AUTOPILOT_REPAIR_REPORT_JSON_PATH || '/tmp/autopilot-repair-report.json';
const MAX_CONTEXT_FILES = parsePositiveInt(process.env.PREMIUM_AI_REPAIR_MAX_FILES, 8);
const MAX_FILE_CHARS = parsePositiveInt(process.env.PREMIUM_AI_REPAIR_MAX_FILE_CHARS, 60_000);
const MAX_DOC_CHARS = parsePositiveInt(process.env.PREMIUM_AI_REPAIR_MAX_DOC_CHARS, 12_000);
const MAX_REPLY_TOKENS = parsePositiveInt(process.env.PREMIUM_AI_REPAIR_MAX_TOKENS, 24_000);

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

type PremiumAiReport = {
  status:
    | 'blocked'
    | 'applied'
    | 'content_replacement_applied'
    | 'no_conflicts'
    | 'model_failed'
    | 'patch_parse_failed'
    | 'patch_apply_failed';
  mode: 'apply_repairs';
  model: string;
  generatedAt: string;
  conflictFiles: string[];
  blockedFiles: string[];
  appliedFiles: string[];
  summary: string;
  files: PremiumAiFileAssessment[];
  nextActions: string[];
};

type ParsedModelRepair = {
  summary: string;
  files: PremiumAiFileAssessment[];
  nextActions: string[];
  patches: PremiumAiPatch[];
  resolvedFiles: PremiumAiResolvedFile[];
};

function parsePositiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
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

function contextForConflictFile(filePath: string): string {
  const content = readRepoFile(filePath, MAX_FILE_CHARS);
  const base = run(`git show :1:${JSON.stringify(filePath)}`);
  const ours = run(`git show :2:${JSON.stringify(filePath)}`);
  const theirs = run(`git show :3:${JSON.stringify(filePath)}`);
  const sections = [
    `## ${filePath}`,
    '',
    '### Working tree content with conflict markers',
    fenced(content || '(file missing or not readable)', extname(filePath)),
  ];
  if (base) sections.push('### Merge base excerpt', fenced(trimTo(base, 16_000), extname(filePath)));
  if (ours) sections.push('### Ours excerpt', fenced(trimTo(ours, 16_000), extname(filePath)));
  if (theirs) sections.push('### Theirs excerpt', fenced(trimTo(theirs, 16_000), extname(filePath)));
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

function buildPrompt(conflictFiles: string[], blockedFiles: string[]): string {
  const docs = TENANT_INVARIANT_DOCS
    .map((path) => {
      const content = readRepoFile(path);
      return content ? `## ${path}\n\n${content}` : '';
    })
    .filter(Boolean)
    .join('\n\n');
  const autopilotMarkdown = readIfExists(AUTOPILOT_REPORT_PATH, 80_000);
  const selectedFiles = conflictFiles.slice(0, MAX_CONTEXT_FILES);
  const fileContexts = selectedFiles.map(contextForConflictFile).join('\n\n---\n\n');

  return [
    'MasjidWeb Premium AI Repair request.',
    '',
    'Return strict resolved-file JSON. The workflow will write replacements only for conflicted files on the safe-update PR branch, then run tenant safety checks before committing.',
    '',
    'Safety rules:',
    ...SAFETY_RULES.map((rule) => `- ${rule}`),
    '',
    'Required output schema: return ONLY JSON, no markdown fences:',
    '{ "summary": string, "files": [{ "filePath": string, "verdict": "blocked" | "safe_candidate" | "needs_human_review", "summary": string, "safetyConcerns": string[], "content": string | null, "contentBase64": string | null, "unifiedDiff": string | null }], "resolvedFiles": [{ "filePath": string, "content": string }], "patches": [{ "filePath": string, "unifiedDiff": string }], "nextActions": string[] }',
    '',
    'Resolved-file requirements:',
    '- Prefer resolvedFiles/content over unified diffs. Return the complete final file content for each repaired conflicted file.',
    '- resolvedFiles paths must target only the conflicted files listed below.',
    '- The complete content must contain no conflict markers and must not be truncated.',
    '- Use contentBase64 instead of content when escaping large source text would be risky.',
    '- unifiedDiff is accepted only as a legacy fallback; resolvedFiles is safer and preferred.',
    '- Use verdict "blocked" and omit repairs when tenant isolation cannot be proven.',
    '- Do not include prose outside JSON.',
    '',
    `Exact conflicted files: ${conflictFiles.join(', ') || '(none)'}`,
    `Exact blocked files: ${blockedFiles.join(', ') || '(none)'}`,
    '',
    'Tenant invariant docs / summary:',
    docs || 'Preserve MasjidWeb tenant isolation. Never remove tenant_id scoping.',
    '',
    'Autopilot report:',
    autopilotMarkdown || '(no Autopilot report artifact found)',
    '',
    'Conflict file context:',
    fileContexts || '(no conflict file context found)',
  ].join('\n');
}

function buildPatchRecoveryPrompt(args: {
  conflictFiles: string[];
  blockedFiles: string[];
  originalReply: string;
  applyError: string;
}): string {
  return [
    'The previous Premium AI repair returned malformed unified diffs that could not be applied safely.',
    '',
    'Recover by returning complete resolved file contents only. Do not return unified diffs.',
    '',
    'Required output schema: return ONLY JSON, no markdown fences:',
    '{ "summary": string, "files": [{ "filePath": string, "verdict": "blocked" | "safe_candidate" | "needs_human_review", "summary": string, "safetyConcerns": string[], "content": string | null, "contentBase64": string | null }], "resolvedFiles": [{ "filePath": string, "content": string }], "patches": [], "nextActions": string[] }',
    '',
    'Rules:',
    '- Return complete final file contents for only the conflicted files listed below.',
    '- Paths must exactly match the conflicted file allowlist.',
    '- Content must contain no conflict markers and must not be truncated.',
    '- Use contentBase64 if JSON escaping would be risky.',
    '- If you cannot reconstruct a safe final file, return blocked and no resolvedFiles.',
    '',
    `Exact conflicted files: ${args.conflictFiles.join(', ') || '(none)'}`,
    `Exact blocked files: ${args.blockedFiles.join(', ') || '(none)'}`,
    '',
    'Patch apply error:',
    args.applyError,
    '',
    'Original model response:',
    trimTo(args.originalReply, 120_000),
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

function parsePatch(entry: unknown): PremiumAiPatch | null {
  const item = entry as Partial<PremiumAiPatch>;
  if (typeof item.filePath !== 'string' || typeof item.unifiedDiff !== 'string') return null;
  const filePath = item.filePath.trim();
  const unifiedDiff = item.unifiedDiff.trim();
  if (!filePath || !unifiedDiff) return null;
  return { filePath, unifiedDiff };
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
  const explicitPatches = Array.isArray(parsed.patches) ? parsed.patches.map(parsePatch).filter((patch): patch is PremiumAiPatch => Boolean(patch)) : [];
  const filePatches = files
    .filter((file) => file.verdict === 'safe_candidate' && file.unifiedDiff)
    .map((file) => ({ filePath: file.filePath, unifiedDiff: file.unifiedDiff as string }));
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
    patches: [...explicitPatches, ...filePatches],
    resolvedFiles: [...explicitResolvedFiles, ...fileResolvedFiles],
  };
}

function applyPatch(patch: PremiumAiPatch): void {
  const tempDir = mkdtempSync(join(tmpdir(), 'mw-premium-ai-'));
  const patchPath = join(tempDir, `${basename(patch.filePath).replace(/[^a-zA-Z0-9._-]/g, '_')}.patch`);
  writeFileSync(patchPath, `${patch.unifiedDiff.trim()}\n`);
  runOrThrow(`git apply --check --whitespace=nowarn ${JSON.stringify(patchPath)}`);
  runOrThrow(`git apply --whitespace=nowarn ${JSON.stringify(patchPath)}`);
}

function applyResolvedFile(file: PremiumAiResolvedFile, allowedFiles: Set<string>): string {
  const filePath = assertResolvedFileTarget(file, allowedFiles);
  assertResolvedFileContent({ filePath, content: file.content });
  const content = file.content.endsWith('\n') ? file.content : `${file.content}\n`;
  writeFileSync(join(REPO_ROOT, filePath), content);
  return filePath;
}

function validateRepairedFile(filePath: string): void {
  const absolutePath = join(REPO_ROOT, filePath);
  if (!existsSync(absolutePath)) throw new Error(`Repaired file is missing: ${filePath}`);
  const content = readFileSync(absolutePath, 'utf8');
  assertNoConflictMarkers(content, filePath);
  assertBalancedDelimiters(content, filePath);
  const invariantFailures = inspectTenantSensitiveContent(filePath, content);
  if (invariantFailures.length > 0) {
    throw new Error(`Tenant invariant failures after Premium AI patch in ${filePath}: ${invariantFailures.join('; ')}`);
  }
}

function stageRepairedFiles(files: string[]): void {
  for (const file of files) {
    runOrThrow(`git add -- ${JSON.stringify(file)}`);
  }
}

function applyAndValidateResolvedFiles(resolvedFiles: PremiumAiResolvedFile[], allowedFiles: Set<string>): string[] {
  const appliedFiles = uniqueSorted(resolvedFiles.map((file) => applyResolvedFile(file, allowedFiles)));
  for (const file of appliedFiles) {
    validateRepairedFile(file);
  }
  return appliedFiles;
}

function setGithubOutput(name: string, value: string): void {
  const outputPath = process.env.GITHUB_OUTPUT;
  if (!outputPath) return;
  appendFileSync(outputPath, `${name}=${value.replaceAll('\n', ' ')}\n`);
}

function formatMarkdown(report: PremiumAiReport): string {
  const lines = [
    '# Premium AI Repair report',
    '',
    `Status: ${report.status}`,
    `Mode: ${report.mode}`,
    `Model: ${report.model}`,
    `Generated: ${report.generatedAt}`,
    '',
    report.summary,
    '',
    '## Safety posture',
    '',
    report.status === 'applied' || report.status === 'content_replacement_applied'
      ? 'Premium AI repairs were applied only to the safe-update PR branch and staged for workflow verification. Approval remains locked until checks and normal PR CI are green.'
      : 'Premium AI did not leave a committable repair. Production remains unchanged and approval must stay blocked.',
    '',
    '## Applied files',
    '',
    report.appliedFiles.length > 0 ? report.appliedFiles.map((file) => `- ${file}`).join('\n') : '- None',
    '',
    '## Files',
    '',
  ];

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

function writeReports(report: PremiumAiReport): void {
  writeFileSync(REPORT_JSON_PATH, `${JSON.stringify(report, null, 2)}\n`);
  const markdown = formatMarkdown(report);
  writeFileSync(REPORT_PATH, markdown);
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, markdown);
  }
  setGithubOutput('status', report.status);
  setGithubOutput('applied_count', String(report.appliedFiles.length));
  console.log(markdown);
}

function baseReport(args: {
  status: PremiumAiReport['status'];
  model: string;
  conflictFiles: string[];
  blockedFiles: string[];
  appliedFiles?: string[];
  summary: string;
  files?: PremiumAiFileAssessment[];
  nextActions?: string[];
}): PremiumAiReport {
  return {
    status: args.status,
    mode: 'apply_repairs',
    model: args.model,
    generatedAt: new Date().toISOString(),
    conflictFiles: args.conflictFiles,
    blockedFiles: args.blockedFiles,
    appliedFiles: args.appliedFiles ?? [],
    summary: args.summary,
    files: args.files ?? [],
    nextActions: args.nextActions ?? ['Leave this update blocked until repaired and verified.'],
  };
}

async function requestContentRecovery(args: {
  apiKey: string;
  model: string;
  conflictFiles: string[];
  blockedFiles: string[];
  originalReply: string;
  applyError: string;
}): Promise<{ result: OpenRouterRepairResult; parsed: ParsedModelRepair }> {
  const result = await requestOpenRouterRepair({
    apiKey: args.apiKey,
    model: args.model,
    messages: [
      {
        role: 'system',
        content: [
          'You are recovering a malformed MasjidWeb Premium AI patch.',
          'Return only valid JSON using complete resolved file contents. Do not return unified diffs.',
          'Generate safe repairs only when tenant invariants are preserved.',
          ...SAFETY_RULES,
        ].join('\n'),
      },
      { role: 'user', content: buildPatchRecoveryPrompt(args) },
    ],
    maxTokens: MAX_REPLY_TOKENS,
  }, 1);
  return { result, parsed: parseModelRepair(result.reply) };
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
  const result = await requestOpenRouterRepair({
    apiKey,
    model,
    messages: [
      {
        role: 'system',
        content: [
          'You are a frontier-model code repair agent for MasjidWeb core-update merge conflicts.',
          'Return only valid JSON using the requested schema.',
          'Prefer complete resolved file contents over unified diffs to avoid malformed patch hunks.',
          'Generate safe repairs only when tenant invariants are preserved.',
          ...SAFETY_RULES,
        ].join('\n'),
      },
      { role: 'user', content: buildPrompt(conflictFiles, blockedFiles) },
    ],
    maxTokens: MAX_REPLY_TOKENS,
  });

  let parsed: ParsedModelRepair;
  try {
    parsed = parseModelRepair(result.reply);
  } catch (error) {
    writeReports(baseReport({
      status: 'patch_parse_failed',
      model: result.model,
      conflictFiles,
      blockedFiles,
      summary: `Premium AI response was not parseable repair JSON: ${error instanceof Error ? error.message : String(error)}`,
      nextActions: ['Leave this update blocked. Inspect the workflow log, then retry Premium AI Repair or repair manually.'],
    }));
    throw error;
  }

  const allowedFiles = new Set(conflictFiles);
  const resolvedFiles = parsed.resolvedFiles.filter((file, index, list) =>
    list.findIndex((other) => other.filePath === file.filePath && other.content === file.content) === index,
  );
  const patches = parsed.patches.filter((patch, index, list) =>
    list.findIndex((other) => other.filePath === patch.filePath && other.unifiedDiff === patch.unifiedDiff) === index,
  );

  if (resolvedFiles.length === 0 && patches.length === 0) {
    writeReports(baseReport({
      status: 'blocked',
      model: result.model,
      conflictFiles,
      blockedFiles,
      summary: parsed.summary || 'Premium AI did not return an applicable repair.',
      files: parsed.files,
      nextActions: parsed.nextActions,
    }));
    throw new Error('Premium AI did not return any applicable file replacements or unified diffs.');
  }

  try {
    let appliedFiles: string[] = [];
    let status: PremiumAiReport['status'] = 'applied';

    if (resolvedFiles.length > 0) {
      appliedFiles = applyAndValidateResolvedFiles(resolvedFiles, allowedFiles);
      status = 'content_replacement_applied';
    } else {
      try {
        for (const patch of patches) {
          assertPatchTargets(patch, allowedFiles);
          applyPatch(patch);
        }
        appliedFiles = uniqueSorted(patches.flatMap((patch) => filesMentionedInDiff(patch.unifiedDiff)));
        for (const file of appliedFiles) {
          validateRepairedFile(file);
        }
      } catch (patchError) {
        const applyError = patchError instanceof Error ? patchError.message : String(patchError);
        const recovery = await requestContentRecovery({
          apiKey,
          model: result.model,
          conflictFiles,
          blockedFiles,
          originalReply: result.reply,
          applyError,
        });
        if (recovery.parsed.resolvedFiles.length === 0) {
          throw patchError;
        }
        const recoveryFiles = recovery.parsed.resolvedFiles.filter((file, index, list) =>
          list.findIndex((other) => other.filePath === file.filePath && other.content === file.content) === index,
        );
        appliedFiles = applyAndValidateResolvedFiles(recoveryFiles, allowedFiles);
        status = 'content_replacement_applied';
        parsed = recovery.parsed;
      }
    }
    stageRepairedFiles(appliedFiles);
    writeReports(baseReport({
      status,
      model: result.model,
      conflictFiles,
      blockedFiles,
      appliedFiles,
      summary: parsed.summary || `Premium AI applied repairs to ${appliedFiles.length} file(s).`,
      files: parsed.files.map((file) =>
        appliedFiles.includes(file.filePath) ? { ...file, verdict: 'applied' as const } : file,
      ),
      nextActions: [
        'Run completeness, Autopilot guard, tenant isolation, type-check, build, and normal PR CI before approval.',
        ...parsed.nextActions,
      ],
    }));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const status: PremiumAiReport['status'] = resolvedFiles.length > 0 ? 'patch_parse_failed' : 'patch_apply_failed';
    writeReports(baseReport({
      status,
      model: result.model,
      conflictFiles,
      blockedFiles,
      summary: `Premium AI repair was rejected before commit: ${message}`,
      files: parsed.files,
      nextActions: ['Leave approval blocked. Retry Premium AI Repair or repair manually with tenant-scope review.'],
    }));
    throw error;
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
