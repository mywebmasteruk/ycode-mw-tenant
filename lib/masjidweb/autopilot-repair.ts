import { execSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export type AutopilotRepairStatus = 'success' | 'blocked' | 'failed';
export type AutopilotRepairOutcome = 'repaired' | 'blocked' | 'skipped' | 'failed';
export type AutopilotBlockReasonCategory =
  | 'known-resolver-unavailable'
  | 'tenant-invariant-failed'
  | 'conflict-markers-remain'
  | 'mechanical-repair-failed'
  | 'unknown';

export interface CommandResult {
  stdout: string;
  exitCode: number;
}

export interface RepairCommandRunner {
  (command: string): CommandResult;
}

export interface AutopilotRepairAction {
  filePath: string;
  strategy: string;
  outcome: AutopilotRepairOutcome;
  summary: string;
  details: string[];
  reasonCategory: AutopilotBlockReasonCategory;
  nextAction: string;
}

export interface AutopilotGuardRun {
  command: string;
  exitCode: number;
  passed: boolean;
  output: string;
}

export interface AutopilotRepairReport {
  version: '2.2';
  status: AutopilotRepairStatus;
  startedAt: string;
  completedAt: string;
  conflictFiles: string[];
  repairedFiles: string[];
  blockedFiles: string[];
  failedFiles: string[];
  blockedByReason: Record<AutopilotBlockReasonCategory, string[]>;
  actions: AutopilotRepairAction[];
  guard: AutopilotGuardRun | null;
  humanSummary: string;
  dashboardNextAction: string;
}

export interface RunAutopilotRepairOptions {
  repoRoot: string;
  runCommand?: RepairCommandRunner;
  runGuard?: boolean;
  reportPath?: string;
  jsonReportPath?: string;
}

interface RequiredInvariant {
  name: string;
  isPresent: (content: string) => boolean;
  message: string;
}

const CONFLICT_MARKER_PATTERN = /^<<<<<<<|^=======|^>>>>>>>|^\|\|\|\|\|\|\|/m;

const HIGH_RISK_EXACT_FILES = new Set([
  'app/(builder)/ycode/api/publish/route.ts',
  'lib/page-fetcher.ts',
  'lib/repositories/collectionItemRepository.ts',
  'lib/repositories/collectionItemValueRepository.ts',
  'lib/repositories/pageRepository.ts',
  'lib/services/collectionService.ts',
]);

const SUPABASE_TENANT_TABLES = [
  'collections',
  'collection_fields',
  'collection_items',
  'collection_item_values',
  'components',
  'locales',
  'page_folders',
  'page_layers',
  'pages',
];

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))].sort();
}

export function hasConflictMarkers(content: string): boolean {
  return CONFLICT_MARKER_PATTERN.test(content);
}

function defaultRunCommand(repoRoot: string): RepairCommandRunner {
  return (command: string) => {
    try {
      const stdout = execSync(command, {
        cwd: repoRoot,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      return { stdout, exitCode: 0 };
    } catch (error: unknown) {
      const err = error as { stdout?: Buffer | string; stderr?: Buffer | string; status?: number };
      const stdout = [err.stdout, err.stderr]
        .map((part) => (Buffer.isBuffer(part) ? part.toString('utf8') : part ?? ''))
        .filter(Boolean)
        .join('\n');
      return { stdout, exitCode: typeof err.status === 'number' ? err.status : 1 };
    }
  };
}

function runList(command: string, runCommand: RepairCommandRunner): string[] {
  const result = runCommand(command);
  if (result.exitCode !== 0 || !result.stdout.trim()) return [];
  return result.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

export function listAutopilotConflictFiles(runCommand: RepairCommandRunner): string[] {
  const unmerged = runList('git diff --name-only --diff-filter=U', runCommand);
  const markerFiles = runList('git grep -l "^<<<<<<<" -- . ":(exclude)node_modules"', runCommand);
  return uniqueSorted([...unmerged, ...markerFiles]);
}

export function isHighRiskAutopilotRepairFile(filePath: string): boolean {
  return HIGH_RISK_EXACT_FILES.has(filePath);
}

function repositoryInvariants(filePath: string): RequiredInvariant[] {
  return [
    {
      name: 'tenant resolver present',
      isPresent: (content) => content.includes('resolveEffectiveTenantId') || content.includes('getTenantIdFromHeaders'),
      message: `${filePath} must resolve the effective tenant before service-role or Knex data access.`,
    },
    {
      name: 'tenant filter present',
      isPresent: (content) =>
        content.includes('applyTenantEq') ||
        content.includes(".eq('tenant_id'") ||
        content.includes('.eq("tenant_id"') ||
        content.includes("where('tenant_id'") ||
        content.includes('tenant_id: tenantId') ||
        content.includes('tenant_id: effectiveTenantId') ||
        content.includes('set_tenant_context'),
      message: `${filePath} must keep tenant_id filters, inserts, or explicit tenant context.`,
    },
    {
      name: 'no invalid admin client arguments',
      isPresent: (content) => !/getSupabaseAdmin\([^)]+\)/.test(content),
      message: `${filePath} must not call getSupabaseAdmin() with tenant arguments; tenant scope must be resolved and filtered separately.`,
    },
  ];
}

function publishInvariants(filePath: string): RequiredInvariant[] {
  return [
    {
      name: 'publish tenant resolver present',
      isPresent: (content) => content.includes('resolveEffectiveTenantId') || content.includes('runWithEffectiveTenantId'),
      message: `${filePath} must keep explicit tenant resolution so one tenant cannot publish another tenant.`,
    },
    {
      name: 'publish tenant context wrapper present',
      isPresent: (content) => content.includes('runWithEffectiveTenantId'),
      message: `${filePath} must execute publish work inside the effective tenant context.`,
    },
  ];
}

function tableQueryPattern(table: string): RegExp {
  return new RegExp(`\\.from\\(\\s*['"]${table}['"]\\s*\\)`, 'g');
}

function hasUnscopedTableQuery(content: string, table: string): boolean {
  const pattern = tableQueryPattern(table);
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(content)) !== null) {
    const start = Math.max(0, match.index - 500);
    const end = Math.min(content.length, match.index + 900);
    const window = content.slice(start, end);
    if (!window.includes('applyTenantEq') && !window.includes(".eq('tenant_id'") && !window.includes('.eq("tenant_id"')) {
      return true;
    }
  }
  return false;
}

function pageFetcherInvariants(filePath: string): RequiredInvariant[] {
  return [
    {
      name: 'tenant resolver present',
      isPresent: (content) => content.includes('resolveEffectiveTenantId'),
      message: `${filePath} must preserve host/subdomain tenant resolution via resolveEffectiveTenantId().`,
    },
    {
      name: 'tenant filter helper present',
      isPresent: (content) => content.includes('applyTenantEq'),
      message: `${filePath} must apply tenant filters to Supabase reads that load pages, folders, layers, locales, components, and CMS data.`,
    },
    {
      name: 'page reads tenant scoped',
      isPresent: (content) => !hasUnscopedTableQuery(content, 'pages'),
      message: `${filePath} must not read pages through the service-role client without applyTenantEq or an explicit tenant_id filter.`,
    },
    {
      name: 'page layer reads tenant scoped',
      isPresent: (content) => !hasUnscopedTableQuery(content, 'page_layers'),
      message: `${filePath} must not read page_layers through the service-role client without applyTenantEq or an explicit tenant_id filter.`,
    },
    {
      name: 'collection item reads tenant scoped',
      isPresent: (content) => !hasUnscopedTableQuery(content, 'collection_items'),
      message: `${filePath} must not read collection_items through the service-role client without applyTenantEq or an explicit tenant_id filter.`,
    },
    {
      name: 'no invalid admin client arguments',
      isPresent: (content) => !/getSupabaseAdmin\([^)]+\)/.test(content),
      message: `${filePath} must not call getSupabaseAdmin() with tenant arguments; tenant scope must be resolved and filtered separately.`,
    },
  ];
}

function collectionServiceInvariants(filePath: string): RequiredInvariant[] {
  return [
    {
      name: 'tenant resolver present',
      isPresent: (content) => content.includes('resolveEffectiveTenantId') || content.includes('getTenantIdFromHeaders'),
      message: `${filePath} must resolve tenant context before service-role Supabase or Knex reads/writes.`,
    },
    {
      name: 'tenant filter helper present',
      isPresent: (content) => content.includes('applyTenantEq'),
      message: `${filePath} must retain applyTenantEq for service-role Supabase reads/deletes and tenant_id on writes.`,
    },
    {
      name: 'service-role table reads tenant scoped',
      isPresent: (content) => !SUPABASE_TENANT_TABLES.some((table) => hasUnscopedTableQuery(content, table)),
      message: `${filePath} must not use service-role table reads without applyTenantEq, tenant_id inserts, or tenant-scoped repository helpers.`,
    },
    {
      name: 'knex tenant filter present',
      isPresent: (content) => !content.includes('getKnexClient') || content.includes('getTenantIdFromHeaders') || content.includes("where('tenant_id'") || content.includes('.where("tenant_id"'),
      message: `${filePath} Knex paths must resolve tenant context and filter by tenant_id when reading tenant tables.`,
    },
    {
      name: 'no invalid admin client arguments',
      isPresent: (content) => !/getSupabaseAdmin\([^)]+\)/.test(content),
      message: `${filePath} must not call getSupabaseAdmin() with tenant arguments; tenant scope must be resolved and filtered separately.`,
    },
  ];
}

function requiredInvariantsForFile(filePath: string): RequiredInvariant[] {
  if (filePath.startsWith('lib/repositories/')) return repositoryInvariants(filePath);
  if (filePath === 'app/(builder)/ycode/api/publish/route.ts') return publishInvariants(filePath);
  if (filePath === 'lib/page-fetcher.ts') return pageFetcherInvariants(filePath);
  if (filePath === 'lib/services/collectionService.ts') return collectionServiceInvariants(filePath);
  return [];
}

export function inspectHighRiskFile(repoRoot: string, filePath: string): string[] {
  const absolutePath = join(repoRoot, filePath);
  if (!existsSync(absolutePath)) {
    return [`${filePath} is missing, so tenant-scope invariants cannot be proven.`];
  }

  const content = readFileSync(absolutePath, 'utf8');
  const failures: string[] = [];
  if (hasConflictMarkers(content)) {
    failures.push(`${filePath} still contains conflict markers, so Autopilot cannot prove tenant-scope invariants safely.`);
  }

  for (const invariant of requiredInvariantsForFile(filePath)) {
    if (!invariant.isPresent(content)) {
      failures.push(`${invariant.name}: ${invariant.message}`);
    }
  }

  return failures;
}

function categorizeBlockedAction(details: string[]): AutopilotBlockReasonCategory {
  if (details.some((detail) => detail.includes('still contains conflict markers'))) return 'conflict-markers-remain';
  if (details.some((detail) => detail.includes(': '))) return 'tenant-invariant-failed';
  if (details.some((detail) => detail.includes('no deterministic') || detail.includes('no registered deterministic'))) {
    return 'known-resolver-unavailable';
  }
  return 'unknown';
}

function nextActionForCategory(category: AutopilotBlockReasonCategory, filePath: string): string {
  switch (category) {
    case 'known-resolver-unavailable':
      return `Extract a deterministic seam resolver for ${filePath}, then retry Autopilot.`;
    case 'tenant-invariant-failed':
      return `Restore the missing tenant invariant in ${filePath}, then run Autopilot guard and tenant tests.`;
    case 'conflict-markers-remain':
      return `Resolve conflict markers in ${filePath} without removing tenant scope, then retry Autopilot.`;
    case 'mechanical-repair-failed':
      return `Review the mechanical repair failure for ${filePath}, then rerun Retry Autopilot after fixing the input.`;
    case 'unknown':
      return `Ask a developer to inspect ${filePath}; Autopilot could not prove this file safe.`;
    default: {
      const exhaustive: never = category;
      return exhaustive;
    }
  }
}

function blockedByReason(actions: AutopilotRepairAction[]): Record<AutopilotBlockReasonCategory, string[]> {
  return {
    'known-resolver-unavailable': actions.filter((action) => action.reasonCategory === 'known-resolver-unavailable').map((action) => action.filePath),
    'tenant-invariant-failed': actions.filter((action) => action.reasonCategory === 'tenant-invariant-failed').map((action) => action.filePath),
    'conflict-markers-remain': actions.filter((action) => action.reasonCategory === 'conflict-markers-remain').map((action) => action.filePath),
    'mechanical-repair-failed': actions.filter((action) => action.reasonCategory === 'mechanical-repair-failed').map((action) => action.filePath),
    unknown: actions.filter((action) => action.reasonCategory === 'unknown').map((action) => action.filePath),
  };
}

function withActionMetadata(action: Omit<AutopilotRepairAction, 'reasonCategory' | 'nextAction'>): AutopilotRepairAction {
  const reasonCategory: AutopilotBlockReasonCategory = action.outcome === 'failed'
    ? 'mechanical-repair-failed'
    : action.outcome === 'blocked'
      ? categorizeBlockedAction(action.details)
      : 'unknown';
  return {
    ...action,
    reasonCategory,
    nextAction: action.outcome === 'blocked' || action.outcome === 'failed'
      ? nextActionForCategory(reasonCategory, action.filePath)
      : 'Continue normal CI and preview checks before approval.',
  };
}

function repairPackageLock(repoRoot: string, runCommand: RepairCommandRunner): AutopilotRepairAction {
  const packageJsonPath = join(repoRoot, 'package.json');
  if (!existsSync(packageJsonPath)) {
    return withActionMetadata({
      filePath: 'package-lock.json',
      strategy: 'npm-lockfile-only',
      outcome: 'blocked',
      summary: 'Cannot regenerate package-lock.json because package.json is missing.',
      details: ['Autopilot only regenerates lockfiles from an existing package.json.'],
    });
  }

  const packageJsonBefore = readFileSync(packageJsonPath, 'utf8');
  const checkout = runCommand('git checkout --ours -- package-lock.json');
  if (checkout.exitCode !== 0) {
    return withActionMetadata({
      filePath: 'package-lock.json',
      strategy: 'npm-lockfile-only',
      outcome: 'failed',
      summary: 'Could not choose the current package-lock.json side before regeneration.',
      details: [checkout.stdout || 'git checkout --ours failed'],
    });
  }

  const install = runCommand('npm install --package-lock-only --ignore-scripts --no-audit --no-fund --legacy-peer-deps');
  if (install.exitCode !== 0) {
    return withActionMetadata({
      filePath: 'package-lock.json',
      strategy: 'npm-lockfile-only',
      outcome: 'failed',
      summary: 'npm could not regenerate package-lock.json from package.json.',
      details: [install.stdout || 'npm install --package-lock-only failed'],
    });
  }

  const packageJsonAfter = readFileSync(packageJsonPath, 'utf8');
  if (packageJsonAfter !== packageJsonBefore) {
    writeFileSync(packageJsonPath, packageJsonBefore);
    return withActionMetadata({
      filePath: 'package-lock.json',
      strategy: 'npm-lockfile-only',
      outcome: 'blocked',
      summary: 'npm attempted to change package.json while regenerating package-lock.json.',
      details: ['Autopilot v2.2 refuses to silently modify package.json; a developer must review this dependency conflict.'],
    });
  }

  const add = runCommand('git add -- package-lock.json');
  if (add.exitCode !== 0) {
    return withActionMetadata({
      filePath: 'package-lock.json',
      strategy: 'npm-lockfile-only',
      outcome: 'failed',
      summary: 'Regenerated package-lock.json but could not stage it.',
      details: [add.stdout || 'git add package-lock.json failed'],
    });
  }

  return withActionMetadata({
    filePath: 'package-lock.json',
    strategy: 'npm-lockfile-only',
    outcome: 'repaired',
    summary: 'Regenerated package-lock.json mechanically from package.json.',
    details: ['Ran npm install --package-lock-only with scripts, audit, and funding disabled.'],
  });
}

function blockHighRiskFile(repoRoot: string, filePath: string): AutopilotRepairAction {
  const failures = inspectHighRiskFile(repoRoot, filePath);
  return withActionMetadata({
    filePath,
    strategy: 'fail-closed-tenant-seam',
    outcome: 'blocked',
    summary: 'Tenant-sensitive conflict requires developer resolution before approval.',
    details: failures.length > 0 ? failures : [`${filePath} is tenant-sensitive and has no registered deterministic v2.2 resolver.`],
  });
}

function blockUnknownFile(filePath: string): AutopilotRepairAction {
  return withActionMetadata({
    filePath,
    strategy: 'no-known-deterministic-repair',
    outcome: 'blocked',
    summary: 'No deterministic repair strategy is registered for this conflicted file.',
    details: ['Autopilot v2.2 only repairs registered deterministic conflict classes and fails closed for tenant-sensitive seams.'],
  });
}

function runAutopilotGuard(runCommand: RepairCommandRunner): AutopilotGuardRun {
  const command = 'npm run updates:autopilot-guard';
  const result = runCommand(command);
  return {
    command,
    exitCode: result.exitCode,
    passed: result.exitCode === 0,
    output: result.stdout,
  };
}

function summarizeReport(status: AutopilotRepairStatus, actions: AutopilotRepairAction[], guard: AutopilotGuardRun | null): string {
  const repaired = actions.filter((action) => action.outcome === 'repaired').length;
  const blocked = actions.filter((action) => action.outcome === 'blocked').length;
  const failed = actions.filter((action) => action.outcome === 'failed').length;

  if (status === 'success') {
    return repaired > 0
      ? `Autopilot v2.2 repaired ${repaired} known mechanical conflict(s) and the tenant guard passed.`
      : 'Autopilot v2.2 found no conflicts needing deterministic repair and the tenant guard passed.';
  }
  if (failed > 0) {
    return `Autopilot v2.2 failed while repairing ${failed} file(s). Production remains unchanged; inspect the repair report.`;
  }
  if (guard && !guard.passed) {
    return 'Autopilot v2.2 completed known repair attempts, but the tenant guard failed. Do not approve this update.';
  }
  return `Autopilot v2.2 blocked ${blocked} file(s) to protect tenant data. Review the blocked reason groups and next actions.`;
}

function dashboardNextActionFor(status: AutopilotRepairStatus, actions: AutopilotRepairAction[], guard: AutopilotGuardRun | null): string {
  if (status === 'success') return 'Refresh PR status and wait for normal CI to finish green before approval.';
  if (guard && !guard.passed) return 'Do not approve. Fix Autopilot guard failures, then rerun tenant-scope verification.';
  const firstBlocked = actions.find((action) => action.outcome === 'blocked' || action.outcome === 'failed');
  return firstBlocked?.nextAction ?? 'Do not approve. Ask a developer to review blocked Autopilot repair output.';
}

export function formatAutopilotRepairMarkdown(report: AutopilotRepairReport): string {
  const lines = [
    '# Core Update Autopilot v2.2 repair report',
    '',
    `Status: ${report.status}`,
    `Started: ${report.startedAt}`,
    `Completed: ${report.completedAt}`,
    '',
    report.humanSummary,
    '',
    '## Summary',
    '',
    `- Conflicted files: **${report.conflictFiles.length}**`,
    `- Repaired files: **${report.repairedFiles.length}**${report.repairedFiles.length > 0 ? ` — ${report.repairedFiles.join(', ')}` : ''}`,
    `- Blocked files: **${report.blockedFiles.length}**${report.blockedFiles.length > 0 ? ` — ${report.blockedFiles.join(', ')}` : ''}`,
    `- Failed files: **${report.failedFiles.length}**${report.failedFiles.length > 0 ? ` — ${report.failedFiles.join(', ')}` : ''}`,
    `- Dashboard next action: ${report.dashboardNextAction}`,
  ];

  const reasonLabels: Record<AutopilotBlockReasonCategory, string> = {
    'known-resolver-unavailable': 'Known resolver unavailable',
    'tenant-invariant-failed': 'Tenant invariant failed',
    'conflict-markers-remain': 'Conflict markers remain',
    'mechanical-repair-failed': 'Mechanical repair failed',
    unknown: 'Unknown',
  };

  const blockedGroups = Object.entries(report.blockedByReason).filter(([, files]) => files.length > 0) as Array<[
    AutopilotBlockReasonCategory,
    string[],
  ]>;
  if (blockedGroups.length > 0) {
    lines.push('', '## Blocked reason groups');
    for (const [category, files] of blockedGroups) {
      lines.push('', `### ${reasonLabels[category]}`, ...files.map((filePath) => `- ${filePath}`));
    }
  }

  if (report.actions.length > 0) {
    lines.push('', '## Actions');
    for (const action of report.actions) {
      lines.push(
        '',
        `### ${action.filePath}`,
        '',
        `- Strategy: ${action.strategy}`,
        `- Outcome: ${action.outcome}`,
        `- Reason category: ${action.reasonCategory}`,
        `- Summary: ${action.summary}`,
        `- Next action: ${action.nextAction}`,
      );
      if (action.details.length > 0) {
        lines.push('- Details:', ...action.details.map((detail) => `  - ${detail}`));
      }
    }
  }

  if (report.guard) {
    lines.push(
      '',
      '## Autopilot guard',
      '',
      `- Command: \`${report.guard.command}\``,
      `- Passed: **${report.guard.passed ? 'yes' : 'no'}**`,
      `- Exit code: ${report.guard.exitCode}`,
    );
    if (report.guard.output.trim()) {
      lines.push('', '```text', report.guard.output.trim(), '```');
    }
  }

  return `${lines.join('\n')}\n`;
}

export function runAutopilotRepair(options: RunAutopilotRepairOptions): AutopilotRepairReport {
  const startedAt = new Date().toISOString();
  const runCommand = options.runCommand ?? defaultRunCommand(options.repoRoot);
  const conflictFiles = listAutopilotConflictFiles(runCommand);
  const actions: AutopilotRepairAction[] = [];

  for (const filePath of conflictFiles) {
    if (filePath === 'package-lock.json') {
      actions.push(repairPackageLock(options.repoRoot, runCommand));
    } else if (isHighRiskAutopilotRepairFile(filePath)) {
      actions.push(blockHighRiskFile(options.repoRoot, filePath));
    } else {
      actions.push(blockUnknownFile(filePath));
    }
  }

  const hasBlockedOrFailed = actions.some((action) => action.outcome === 'blocked' || action.outcome === 'failed');
  let guard: AutopilotGuardRun | null = null;
  if ((options.runGuard ?? true) && !hasBlockedOrFailed) {
    guard = runAutopilotGuard(runCommand);
  }

  const failedFiles = actions.filter((action) => action.outcome === 'failed').map((action) => action.filePath);
  const blockedFiles = actions.filter((action) => action.outcome === 'blocked').map((action) => action.filePath);
  const repairedFiles = actions.filter((action) => action.outcome === 'repaired').map((action) => action.filePath);

  const status: AutopilotRepairStatus =
    failedFiles.length > 0 ? 'failed' : blockedFiles.length > 0 || (guard && !guard.passed) ? 'blocked' : 'success';

  const report: AutopilotRepairReport = {
    version: '2.2',
    status,
    startedAt,
    completedAt: new Date().toISOString(),
    conflictFiles,
    repairedFiles,
    blockedFiles,
    failedFiles,
    blockedByReason: blockedByReason(actions),
    actions,
    guard,
    humanSummary: summarizeReport(status, actions, guard),
    dashboardNextAction: dashboardNextActionFor(status, actions, guard),
  };

  if (options.jsonReportPath) {
    writeFileSync(options.jsonReportPath, `${JSON.stringify(report, null, 2)}\n`);
  }
  if (options.reportPath) {
    writeFileSync(options.reportPath, formatAutopilotRepairMarkdown(report));
  }

  return report;
}
