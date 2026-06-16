import { execSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { inspectTenantSensitiveContent } from './autopilot-tenant-invariants';

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
  version: '2.3';
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

export { hasConflictMarkers } from './autopilot-tenant-invariants';

const HIGH_RISK_EXACT_FILES = new Set([
  'app/(builder)/ycode/api/publish/route.ts',
  'lib/page-fetcher.ts',
  'lib/repositories/collectionItemRepository.ts',
  'lib/repositories/collectionItemValueRepository.ts',
  'lib/repositories/pageRepository.ts',
  'lib/services/collectionService.ts',
]);

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))].sort();
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

export function inspectHighRiskFile(repoRoot: string, filePath: string): string[] {
  const absolutePath = join(repoRoot, filePath);
  if (!existsSync(absolutePath)) {
    return [`${filePath} is missing, so tenant-scope invariants cannot be proven.`];
  }

  return inspectTenantSensitiveContent(filePath, readFileSync(absolutePath, 'utf8'));
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
  const blockingActions = actions.filter((action) => action.outcome === 'blocked' || action.outcome === 'failed');
  return {
    'known-resolver-unavailable': blockingActions.filter((action) => action.reasonCategory === 'known-resolver-unavailable').map((action) => action.filePath),
    'tenant-invariant-failed': blockingActions.filter((action) => action.reasonCategory === 'tenant-invariant-failed').map((action) => action.filePath),
    'conflict-markers-remain': blockingActions.filter((action) => action.reasonCategory === 'conflict-markers-remain').map((action) => action.filePath),
    'mechanical-repair-failed': blockingActions.filter((action) => action.reasonCategory === 'mechanical-repair-failed').map((action) => action.filePath),
    unknown: blockingActions.filter((action) => action.reasonCategory === 'unknown').map((action) => action.filePath),
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
      details: ['Autopilot v2.3 refuses to silently modify package.json; a developer must review this dependency conflict.'],
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

interface ConflictBlock {
  before: string;
  ours: string;
  theirs: string;
  after: string;
}

interface DeterministicSeamRepair {
  content: string;
  details: string[];
}

const DETERMINISTIC_SEAM_RESOLVERS = new Set([
  'lib/page-fetcher.ts',
  'lib/services/collectionService.ts',
]);

function parseFirstConflictBlock(content: string): ConflictBlock | null {
  const start = content.indexOf('<<<<<<<');
  if (start === -1) return null;

  const oursStart = content.indexOf('\n', start);
  const separator = content.indexOf('\n=======', oursStart);
  const endMarker = content.indexOf('\n>>>>>>>', separator);
  if (oursStart === -1 || separator === -1 || endMarker === -1) return null;

  const afterMarker = content.indexOf('\n', endMarker + 1);
  const afterStart = afterMarker === -1 ? content.length : afterMarker + 1;

  return {
    before: content.slice(0, start),
    ours: content.slice(oursStart + 1, separator),
    theirs: content.slice(separator + '\n=======\n'.length, endMarker),
    after: content.slice(afterStart),
  };
}

function expandConflictCandidates(content: string, maxCandidates: number = 64): string[] {
  const block = parseFirstConflictBlock(content);
  if (!block) return [content];

  const candidates: string[] = [];
  for (const side of [block.ours, block.theirs]) {
    for (const expanded of expandConflictCandidates(`${block.before}${side}${block.after}`, maxCandidates)) {
      candidates.push(expanded);
      if (candidates.length > maxCandidates) return candidates;
    }
  }
  return candidates;
}

function resolveDeterministicSeam(content: string, filePath: string): DeterministicSeamRepair | null {
  if (!DETERMINISTIC_SEAM_RESOLVERS.has(filePath)) return null;

  const candidates = expandConflictCandidates(content)
    .filter((candidate) => inspectTenantSensitiveContent(filePath, candidate).length === 0);
  const uniqueCandidates = [...new Set(candidates)];

  if (uniqueCandidates.length !== 1) return null;

  return {
    content: uniqueCandidates[0],
    details: [
      `Selected the only conflict-side combination that satisfies ${filePath} tenant invariants.`,
      'No tenant logic was synthesized; candidates were generated only from existing conflict sides.',
    ],
  };
}

function repairDeterministicSeamFile(repoRoot: string, filePath: string, runCommand: RepairCommandRunner): AutopilotRepairAction {
  const absolutePath = join(repoRoot, filePath);
  if (!existsSync(absolutePath)) {
    return blockHighRiskFile(repoRoot, filePath);
  }

  const content = readFileSync(absolutePath, 'utf8');
  const repair = resolveDeterministicSeam(content, filePath);
  if (!repair) {
    return blockHighRiskFile(repoRoot, filePath);
  }

  writeFileSync(absolutePath, repair.content);
  const add = runCommand(`git add -- ${JSON.stringify(filePath)}`);
  if (add.exitCode !== 0) {
    return withActionMetadata({
      filePath,
      strategy: 'deterministic-tenant-seam',
      outcome: 'failed',
      summary: 'Resolved tenant seam deterministically but could not stage the file.',
      details: [add.stdout || `git add ${filePath} failed`],
    });
  }

  return withActionMetadata({
    filePath,
    strategy: 'deterministic-tenant-seam',
    outcome: 'repaired',
    summary: 'Resolved a known tenant-sensitive seam by selecting the only invariant-safe conflict side.',
    details: repair.details,
  });
}

function blockHighRiskFile(repoRoot: string, filePath: string): AutopilotRepairAction {
  const failures = inspectHighRiskFile(repoRoot, filePath);
  return withActionMetadata({
    filePath,
    strategy: 'fail-closed-tenant-seam',
    outcome: 'blocked',
    summary: 'Tenant-sensitive conflict requires developer resolution before approval.',
    details: failures.length > 0 ? failures : [`${filePath} is tenant-sensitive and has no registered deterministic v2.3 resolver.`],
  });
}

function blockUnknownFile(filePath: string): AutopilotRepairAction {
  return withActionMetadata({
    filePath,
    strategy: 'no-known-deterministic-repair',
    outcome: 'blocked',
    summary: 'No deterministic repair strategy is registered for this conflicted file.',
    details: ['Autopilot v2.3 only repairs registered deterministic conflict classes and fails closed for tenant-sensitive seams.'],
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
      ? `Autopilot v2.3 repaired ${repaired} known mechanical conflict(s) and the tenant guard passed.`
      : 'Autopilot v2.3 found no conflicts needing deterministic repair and the tenant guard passed.';
  }
  if (failed > 0) {
    return `Autopilot v2.3 failed while repairing ${failed} file(s). Production remains unchanged; inspect the repair report.`;
  }
  if (guard && !guard.passed) {
    return 'Autopilot v2.3 completed known repair attempts, but the tenant guard failed. Do not approve this update.';
  }
  return `Autopilot v2.3 blocked ${blocked} file(s) to protect tenant data. Review the blocked reason groups and next actions.`;
}

function dashboardNextActionFor(status: AutopilotRepairStatus, actions: AutopilotRepairAction[], guard: AutopilotGuardRun | null): string {
  if (status === 'success') return 'Refresh PR status and wait for normal CI to finish green before approval.';
  if (guard && !guard.passed) return 'Do not approve. Fix Autopilot guard failures, then rerun tenant-scope verification.';
  const firstBlocked = actions.find((action) => action.outcome === 'blocked' || action.outcome === 'failed');
  return firstBlocked?.nextAction ?? 'Do not approve. Ask a developer to review blocked Autopilot repair output.';
}

export function formatAutopilotRepairMarkdown(report: AutopilotRepairReport): string {
  const lines = [
    '# Core Update Autopilot v2.3 repair report',
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
      actions.push(repairDeterministicSeamFile(options.repoRoot, filePath, runCommand));
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
    version: '2.3',
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
