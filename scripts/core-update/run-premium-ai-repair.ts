import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { extname, join } from 'node:path';
import { execSync } from 'node:child_process';
import {
  DEFAULT_PREMIUM_AI_REPAIR_MODEL,
  requestOpenRouterRepair,
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
const MAX_REPLY_TOKENS = parsePositiveInt(process.env.PREMIUM_AI_REPAIR_MAX_TOKENS, 16_000);

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
  'If safety cannot be proven from the supplied context, leave the file blocked and explain exactly what must be reviewed.',
];

type AutopilotReportJson = {
  blockedFiles?: string[];
  conflictFiles?: string[];
  actions?: Array<{ filePath?: string; outcome?: string; summary?: string; details?: string[] }>;
};

type PremiumAiFileAssessment = {
  filePath: string;
  verdict: 'blocked' | 'safe_candidate' | 'needs_human_review';
  summary: string;
  safetyConcerns: string[];
  unifiedDiff: string | null;
};

type PremiumAiReport = {
  status: 'blocked' | 'no_conflicts' | 'model_failed';
  mode: 'dry_run_report';
  model: string;
  generatedAt: string;
  conflictFiles: string[];
  blockedFiles: string[];
  summary: string;
  files: PremiumAiFileAssessment[];
  nextActions: string[];
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
    'MasjidWeb Premium AI Repair review request.',
    '',
    'This is DRY-RUN REPORT MODE. Do not claim the pull request is resolved. Return machine-readable advice only.',
    '',
    'Safety rules:',
    ...SAFETY_RULES.map((rule) => `- ${rule}`),
    '',
    'Required output schema: return ONLY JSON, no markdown fences:',
    '{ "summary": string, "files": [{ "filePath": string, "verdict": "blocked" | "safe_candidate" | "needs_human_review", "summary": string, "safetyConcerns": string[], "unifiedDiff": string | null }], "nextActions": string[] }',
    '',
    'Do not invent files not shown. If you include unifiedDiff, it must be a standard unified diff and must preserve all safety rules. Prefer null when uncertain.',
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

function parseModelReport(raw: string, conflictFiles: string[], blockedFiles: string[], model: string): PremiumAiReport {
  const stripped = stripCodeFences(raw);
  const parsed = JSON.parse(stripped) as {
    summary?: unknown;
    files?: unknown;
    nextActions?: unknown;
  };
  const files = Array.isArray(parsed.files)
    ? parsed.files.map((entry): PremiumAiFileAssessment => {
      const item = entry as Partial<PremiumAiFileAssessment>;
      const verdict = item.verdict === 'safe_candidate' || item.verdict === 'needs_human_review' ? item.verdict : 'blocked';
      return {
        filePath: typeof item.filePath === 'string' ? item.filePath : '(unknown)',
        verdict,
        summary: typeof item.summary === 'string' ? item.summary : 'No summary returned.',
        safetyConcerns: Array.isArray(item.safetyConcerns)
          ? item.safetyConcerns.filter((value): value is string => typeof value === 'string')
          : [],
        unifiedDiff: typeof item.unifiedDiff === 'string' && item.unifiedDiff.trim() ? item.unifiedDiff : null,
      };
    })
    : [];

  return {
    status: conflictFiles.length === 0 ? 'no_conflicts' : 'blocked',
    mode: 'dry_run_report',
    model,
    generatedAt: new Date().toISOString(),
    conflictFiles,
    blockedFiles,
    summary: typeof parsed.summary === 'string' ? parsed.summary : 'Premium AI returned a report.',
    files,
    nextActions: Array.isArray(parsed.nextActions)
      ? parsed.nextActions.filter((value): value is string => typeof value === 'string')
      : ['Review the report, resolve conflicts manually, then run Autopilot guard and tenant isolation checks.'],
  };
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
    'This first slice intentionally does not auto-apply model output. A human or a later guarded patch-applier must review any suggested diff, then run conflict marker checks, Autopilot guard, tenant isolation, type-check, build, and normal PR CI before approval.',
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
      lines.push('', '<details><summary>Suggested unified diff (not applied)</summary>', '', '```diff', file.unifiedDiff, '```', '', '</details>');
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
  console.log(markdown);
}

async function main(): Promise<void> {
  const conflictFiles = listConflictFiles();
  const autopilotJson = readAutopilotJson();
  const blockedFiles = blockedFilesFromAutopilot(autopilotJson, conflictFiles);

  if (conflictFiles.length === 0) {
    writeReports({
      status: 'no_conflicts',
      mode: 'dry_run_report',
      model: process.env.OPENROUTER_REPAIR_MODEL?.trim() || process.env.OPENROUTER_MODEL?.trim() || DEFAULT_PREMIUM_AI_REPAIR_MODEL,
      generatedAt: new Date().toISOString(),
      conflictFiles,
      blockedFiles,
      summary: 'No conflicted files or conflict markers were found, so Premium AI Repair had nothing to review.',
      files: [],
      nextActions: ['Continue normal CI, preview, and approval gates.'],
    });
    return;
  }

  const apiKey = process.env.OPENROUTER_API_KEY?.trim();
  if (!apiKey) {
    throw new Error('OPENROUTER_API_KEY is not set. Add it as a GitHub Actions secret before using Premium AI Repair.');
  }

  const model = process.env.OPENROUTER_REPAIR_MODEL?.trim() || process.env.OPENROUTER_MODEL?.trim() || DEFAULT_PREMIUM_AI_REPAIR_MODEL;
  const result = await requestOpenRouterRepair({
    apiKey,
    model,
    messages: [
      {
        role: 'system',
        content: [
          'You are a frontier-model code reviewer for MasjidWeb core-update merge conflicts.',
          'Return only valid JSON using the requested schema.',
          'Your job is to identify safe repair candidates, not to approve or merge.',
          ...SAFETY_RULES,
        ].join('\n'),
      },
      { role: 'user', content: buildPrompt(conflictFiles, blockedFiles) },
    ],
    maxTokens: MAX_REPLY_TOKENS,
  });

  let report: PremiumAiReport;
  try {
    report = parseModelReport(result.reply, conflictFiles, blockedFiles, result.model);
  } catch (error) {
    report = {
      status: 'model_failed',
      mode: 'dry_run_report',
      model: result.model,
      generatedAt: new Date().toISOString(),
      conflictFiles,
      blockedFiles,
      summary: `Premium AI response was not parseable JSON: ${error instanceof Error ? error.message : String(error)}`,
      files: [],
      nextActions: ['Leave this update blocked. Inspect the workflow log, then retry Premium AI Repair or repair manually.'],
    };
  }

  writeReports(report);

  if (report.status !== 'no_conflicts') {
    throw new Error('Premium AI Repair is currently report-only. Suggested diffs were not applied; the update remains blocked until reviewed and verified.');
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
