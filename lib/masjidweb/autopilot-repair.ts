import { execSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export type AutopilotRepairStatus = 'success' | 'blocked' | 'failed';
export type AutopilotRepairOutcome = 'repaired' | 'blocked' | 'skipped' | 'failed';

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
}

export interface AutopilotGuardRun {
  command: string;
  exitCode: number;
  passed: boolean;
  output: string;
}

export interface AutopilotRepairReport {
  version: '2.1';
  status: AutopilotRepairStatus;
  startedAt: string;
  completedAt: string;
  conflictFiles: string[];
  repairedFiles: string[];
  blockedFiles: string[];
  failedFiles: string[];
  actions: AutopilotRepairAction[];
  guard: AutopilotGuardRun | null;
  humanSummary: string;
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
  'lib/repositories/collectionItemRepository.ts',
  'lib/repositories/collectionItemValueRepository.ts',
  'lib/repositories/pageRepository.ts',
]);

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

function requiredInvariantsForFile(filePath: string): RequiredInvariant[] {
  if (filePath.startsWith('lib/repositories/')) return repositoryInvariants(filePath);
  if (filePath === 'app/(builder)/ycode/api/publish/route.ts') return publishInvariants(filePath);
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

function repairPackageLock(repoRoot: string, runCommand: RepairCommandRunner): AutopilotRepairAction {
  const packageJsonPath = join(repoRoot, 'package.json');
  if (!existsSync(packageJsonPath)) {
    return {
      filePath: 'package-lock.json',
      strategy: 'npm-lockfile-only',
      outcome: 'blocked',
      summary: 'Cannot regenerate package-lock.json because package.json is missing.',
      details: ['Autopilot only regenerates lockfiles from an existing package.json.'],
    };
  }

  const packageJsonBefore = readFileSync(packageJsonPath, 'utf8');
  const checkout = runCommand('git checkout --ours -- package-lock.json');
  if (checkout.exitCode !== 0) {
    return {
      filePath: 'package-lock.json',
      strategy: 'npm-lockfile-only',
      outcome: 'failed',
      summary: 'Could not choose the current package-lock.json side before regeneration.',
      details: [checkout.stdout || 'git checkout --ours failed'],
    };
  }

  const install = runCommand('npm install --package-lock-only --ignore-scripts --no-audit --no-fund --legacy-peer-deps');
  if (install.exitCode !== 0) {
    return {
      filePath: 'package-lock.json',
      strategy: 'npm-lockfile-only',
      outcome: 'failed',
      summary: 'npm could not regenerate package-lock.json from package.json.',
      details: [install.stdout || 'npm install --package-lock-only failed'],
    };
  }

  const packageJsonAfter = readFileSync(packageJsonPath, 'utf8');
  if (packageJsonAfter !== packageJsonBefore) {
    writeFileSync(packageJsonPath, packageJsonBefore);
    return {
      filePath: 'package-lock.json',
      strategy: 'npm-lockfile-only',
      outcome: 'blocked',
      summary: 'npm attempted to change package.json while regenerating package-lock.json.',
      details: ['Autopilot v2.1 refuses to silently modify package.json; a developer must review this dependency conflict.'],
    };
  }

  const add = runCommand('git add -- package-lock.json');
  if (add.exitCode !== 0) {
    return {
      filePath: 'package-lock.json',
      strategy: 'npm-lockfile-only',
      outcome: 'failed',
      summary: 'Regenerated package-lock.json but could not stage it.',
      details: [add.stdout || 'git add package-lock.json failed'],
    };
  }

  return {
    filePath: 'package-lock.json',
    strategy: 'npm-lockfile-only',
    outcome: 'repaired',
    summary: 'Regenerated package-lock.json mechanically from package.json.',
    details: ['Ran npm install --package-lock-only with scripts, audit, and funding disabled.'],
  };
}

function blockHighRiskFile(repoRoot: string, filePath: string): AutopilotRepairAction {
  const failures = inspectHighRiskFile(repoRoot, filePath);
  return {
    filePath,
    strategy: 'fail-closed-tenant-seam',
    outcome: 'blocked',
    summary: 'Tenant-sensitive conflict requires developer resolution before approval.',
    details: failures.length > 0 ? failures : [`${filePath} is tenant-sensitive and has no deterministic v2.1 repair strategy.`],
  };
}

function blockUnknownFile(filePath: string): AutopilotRepairAction {
  return {
    filePath,
    strategy: 'no-known-deterministic-repair',
    outcome: 'blocked',
    summary: 'No deterministic repair strategy is registered for this conflicted file.',
    details: ['Autopilot v2.1 only repairs package-lock.json mechanically and fails closed for tenant-sensitive seams.'],
  };
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
      ? `Autopilot v2.1 repaired ${repaired} known mechanical conflict(s) and the tenant guard passed.`
      : 'Autopilot v2.1 found no conflicts needing deterministic repair and the tenant guard passed.';
  }
  if (failed > 0) {
    return `Autopilot v2.1 failed while repairing ${failed} file(s). Production remains unchanged; inspect the repair report.`;
  }
  if (guard && !guard.passed) {
    return 'Autopilot v2.1 completed known repair attempts, but the tenant guard failed. Do not approve this update.';
  }
  return `Autopilot v2.1 blocked ${blocked} file(s) to protect tenant data. A developer must resolve the listed invariants.`;
}

export function formatAutopilotRepairMarkdown(report: AutopilotRepairReport): string {
  const lines = [
    '# Core Update Autopilot v2.1 repair report',
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
    `- Repaired files: **${report.repairedFiles.length}**`,
    `- Blocked files: **${report.blockedFiles.length}**`,
    `- Failed files: **${report.failedFiles.length}**`,
  ];

  if (report.actions.length > 0) {
    lines.push('', '## Actions');
    for (const action of report.actions) {
      lines.push('', `### ${action.filePath}`, '', `- Strategy: ${action.strategy}`, `- Outcome: ${action.outcome}`, `- Summary: ${action.summary}`);
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
    version: '2.1',
    status,
    startedAt,
    completedAt: new Date().toISOString(),
    conflictFiles,
    repairedFiles,
    blockedFiles,
    failedFiles,
    actions,
    guard,
    humanSummary: summarizeReport(status, actions, guard),
  };

  if (options.jsonReportPath) {
    writeFileSync(options.jsonReportPath, `${JSON.stringify(report, null, 2)}\n`);
  }
  if (options.reportPath) {
    writeFileSync(options.reportPath, formatAutopilotRepairMarkdown(report));
  }

  return report;
}
