import { existsSync, readFileSync } from 'node:fs';

export const COPILOT_ESCALATION_MARKER = '<!-- masjidweb-core-update-copilot-escalation -->';

export interface CopilotEscalationInput {
  prNumber: string;
  blockedFiles: string[];
  reportMarkdown?: string;
  reportJson?: unknown;
  artifactUrl?: string;
  workflowRunUrl?: string;
  repository?: string;
}

interface AutopilotReportLike {
  status?: unknown;
  humanSummary?: unknown;
  dashboardNextAction?: unknown;
  blockedFiles?: unknown;
  failedFiles?: unknown;
  conflictFiles?: unknown;
  blockedByReason?: unknown;
  actions?: unknown;
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))].sort();
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string');
}

function asReport(value: unknown): AutopilotReportLike | null {
  if (!value || typeof value !== 'object') return null;
  return value as AutopilotReportLike;
}

function extractBlockedFilesFromReport(reportJson: unknown): string[] {
  const report = asReport(reportJson);
  if (!report) return [];
  const blockedByReason = report.blockedByReason;
  const groupedFiles = blockedByReason && typeof blockedByReason === 'object'
    ? Object.values(blockedByReason as Record<string, unknown>).flatMap(asStringArray)
    : [];

  return uniqueSorted([
    ...asStringArray(report.blockedFiles),
    ...asStringArray(report.failedFiles),
    ...groupedFiles,
  ]);
}

function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, maxLength)}\n\n[Truncated for comment size. Open the linked artifact/run for the full report.]`;
}

function formatReportSummary(reportJson: unknown, reportMarkdown?: string): string[] {
  const report = asReport(reportJson);
  const lines: string[] = [];

  if (report) {
    if (typeof report.status === 'string') lines.push(`- Autopilot status: **${report.status}**`);
    if (typeof report.humanSummary === 'string') lines.push(`- Summary: ${report.humanSummary}`);
    if (typeof report.dashboardNextAction === 'string') lines.push(`- Dashboard next action: ${report.dashboardNextAction}`);

    const conflictFiles = asStringArray(report.conflictFiles);
    if (conflictFiles.length > 0) lines.push(`- Conflict files reported: ${conflictFiles.join(', ')}`);

    const actions = Array.isArray(report.actions) ? report.actions : [];
    const blockedActions = actions
      .filter((action): action is Record<string, unknown> => Boolean(action) && typeof action === 'object')
      .filter((action) => action.outcome === 'blocked' || action.outcome === 'failed');
    if (blockedActions.length > 0) {
      lines.push('- Blocked action details:');
      for (const action of blockedActions.slice(0, 12)) {
        const filePath = typeof action.filePath === 'string' ? action.filePath : 'unknown file';
        const reason = typeof action.reasonCategory === 'string' ? action.reasonCategory : 'unknown';
        const nextAction = typeof action.nextAction === 'string' ? action.nextAction : 'Review manually.';
        lines.push(`  - ${filePath} — ${reason}: ${nextAction}`);
      }
    }
  }

  if (lines.length > 0) return lines;
  if (reportMarkdown?.trim()) {
    return ['```text', truncate(reportMarkdown.trim(), 6000), '```'];
  }
  return ['No Autopilot report content was supplied. Inspect the workflow artifact before editing.'];
}

export function buildCopilotEscalationPrompt(input: CopilotEscalationInput): string {
  const blockedFiles = uniqueSorted([
    ...input.blockedFiles,
    ...extractBlockedFilesFromReport(input.reportJson),
  ]);
  const blockedFileLines = blockedFiles.length > 0
    ? blockedFiles.map((filePath) => `- ${filePath}`)
    : ['- Unknown — inspect the Autopilot report and PR conflicts before changing code.'];

  const contextLinks = [
    input.repository ? `- Repository: ${input.repository}` : null,
    `- Pull request: #${input.prNumber}`,
    input.workflowRunUrl ? `- Workflow run: ${input.workflowRunUrl}` : null,
    input.artifactUrl ? `- Autopilot artifact: ${input.artifactUrl}` : null,
  ].filter((line): line is string => Boolean(line));

  return [
    COPILOT_ESCALATION_MARKER,
    '## MasjidWeb Copilot escalation request',
    '',
    'This is a constrained repair task for a blocked MasjidWeb safe Ycode core update. It is **not** approval to merge this PR. Any commit must still pass the existing Autopilot, tenant-isolation, type-check, build, PR review, and deploy-preview gates.',
    '',
    '### Task',
    '',
    `Repair the blocked safe-update PR #${input.prNumber} with the smallest possible change set. Preserve MasjidWeb tenant isolation and fragile auth/session behavior while resolving only the files named below and any directly required compile/test fallout.`,
    '',
    '### Context',
    '',
    ...contextLinks,
    '',
    '### Blocked files',
    '',
    ...blockedFileLines,
    '',
    '### Hard safety rules',
    '',
    '- Do **not** approve, merge, close, or mark the safe-update PR ready solely because you made a commit.',
    '- Do **not** remove tenant filters or tenant boundary checks to make tests pass.',
    '- Do **not** bypass `tenant_id` checks in service-role, Supabase, PostgREST, or Knex code paths.',
    '- Do **not** pass a tenant argument to `getSupabaseAdmin()`; `getSupabaseAdmin(tenantId)` is an invalid pattern in this fork.',
    '- Preserve and use `resolveEffectiveTenantId`, `applyTenantEq`, and `runWithEffectiveTenantId` where those seams already protect tenant data.',
    '- Preserve host/subdomain tenant resolution and session tenant alignment. Auth metadata must not let tenant A access tenant B.',
    '- No service-role reads, writes, publish, clone, reorder, or delete paths may operate without an effective tenant filter when the table or owner path is tenant-scoped.',
    '- For tables without direct `tenant_id`, scope through the owning tenant table (for example locales for translations) rather than querying globally.',
    '- Do not broad-rewrite tenant-sensitive files. Resolve conflicts surgically and keep existing MasjidWeb seams intact.',
    '- Do not hide partial failures, skipped files, truncated output, or failed commands. Surface them in the PR.',
    '',
    '### Required verification before handing back',
    '',
    'Run these commands from the repository root and report the exact results in the PR:',
    '',
    '```bash',
    'npm run updates:autopilot-guard',
    'bash scripts/check-tenant-isolation.sh',
    'npm run type-check',
    'npm run build',
    '```',
    '',
    'If auth, proxy, cookie, invite, or layout files are touched, also call out that `/ycode/accept-invite`, `/ycode/api/auth/session`, tenant-subdomain session refresh, and Settings → Members invite visibility need preview smoke verification before merge.',
    '',
    '### Autopilot report summary',
    '',
    ...formatReportSummary(input.reportJson, input.reportMarkdown),
  ].join('\n');
}

export function readOptionalTextFile(path: string | undefined): string | undefined {
  if (!path || !existsSync(path)) return undefined;
  return readFileSync(path, 'utf8');
}

export function readOptionalJsonFile(path: string | undefined): unknown {
  if (!path || !existsSync(path)) return undefined;
  return JSON.parse(readFileSync(path, 'utf8'));
}
