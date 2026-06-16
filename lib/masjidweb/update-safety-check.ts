export type LegacyUpdateRiskLevel = 'safe' | 'high' | 'blocked';
export type AutopilotRiskLevel = 'LOW' | 'MEDIUM' | 'HIGH';
export type AutopilotStatus = 'safe' | 'review_required' | 'blocked';
export type AutopilotFileKind =
  | 'tenant-sensitive'
  | 'auth-or-session'
  | 'publish-or-cache'
  | 'repository'
  | 'database-migration'
  | 'lockfile'
  | 'core-config'
  | 'general';

export interface UpdateFileClassification {
  filePath: string;
  riskLevel: AutopilotRiskLevel;
  kind: AutopilotFileKind;
  conflicted: boolean;
  tenantSensitive: boolean;
  reason: string;
  autopilotAction: string;
}

export interface UpdateSafetyResult {
  level: LegacyUpdateRiskLevel;
  status: AutopilotStatus;
  riskLevel: AutopilotRiskLevel;
  changedFiles: string[];
  highRiskFiles: string[];
  mediumRiskFiles: string[];
  lowRiskFiles: string[];
  safeFiles: string[];
  conflictFiles: string[];
  classifications: UpdateFileClassification[];
  blockedReasons: string[];
  nextActions: string[];
  needsDeveloperReview: boolean;
  humanSummary: string;
}

const TENANT_SENSITIVE_PREFIXES = [
  'app/(builder)/ycode/api/auth/',
  'app/(builder)/ycode/api/publish/',
  'app/(builder)/ycode/accept-invite/',
  'app/(builder)/ycode/mcp/',
  'app/(site)/api/',
  'app/(site)/',
  'lib/mcp/',
  'lib/masjidweb/',
  'lib/repositories/',
  'lib/services/cacheService',
  'lib/services/collectionService',
  'lib/services/folderService',
  'lib/services/localisationService',
  'lib/services/pageService',
  'lib/supabase-',
  'stores/useAuthStore.ts',
];

const TENANT_SENSITIVE_EXACT = new Set([
  'proxy.ts',
  'next.config.ts',
  'netlify.toml',
  'lib/page-fetcher.ts',
  'lib/supabase-browser.ts',
  'lib/supabase-cookie-domain.ts',
  'lib/supabase-route-client.ts',
  'app/(builder)/ycode/YCodeLayoutClient.tsx',
]);

const MEDIUM_RISK_PREFIXES = [
  '.github/workflows/',
  'scripts/',
  'lib/updates/',
  'components/',
  'app/(builder)/ycode/components/',
  'hooks/',
  'stores/',
];

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))].sort();
}

function startsWithAny(filePath: string, prefixes: string[]): boolean {
  return prefixes.some((prefix) => filePath.startsWith(prefix));
}

function isTenantSensitiveFile(filePath: string): boolean {
  return TENANT_SENSITIVE_EXACT.has(filePath) || startsWithAny(filePath, TENANT_SENSITIVE_PREFIXES);
}

function classifyKind(filePath: string): AutopilotFileKind {
  if (filePath === 'package-lock.json' || filePath.endsWith('.lock')) return 'lockfile';
  if (filePath.startsWith('database/migrations/')) return 'database-migration';
  if (filePath.startsWith('lib/repositories/')) return 'repository';
  if (
    filePath.startsWith('app/(builder)/ycode/api/auth/') ||
    filePath.startsWith('app/(builder)/ycode/accept-invite/') ||
    filePath === 'proxy.ts' ||
    filePath.includes('supabase-cookie') ||
    filePath.includes('supabase-browser') ||
    filePath.includes('supabase-route-client') ||
    filePath.includes('YCodeLayoutClient')
  ) {
    return 'auth-or-session';
  }
  if (
    filePath.startsWith('app/(builder)/ycode/api/publish/') ||
    filePath.startsWith('lib/services/cacheService') ||
    filePath.startsWith('lib/services/pageService') ||
    filePath.startsWith('lib/services/collectionService')
  ) {
    return 'publish-or-cache';
  }
  if (
    filePath === 'next.config.ts' ||
    filePath === 'netlify.toml' ||
    filePath.startsWith('.github/workflows/') ||
    filePath.startsWith('scripts/')
  ) {
    return 'core-config';
  }
  if (isTenantSensitiveFile(filePath)) return 'tenant-sensitive';
  return 'general';
}

function classifyFile(filePath: string, conflictFiles: Set<string>): UpdateFileClassification {
  const conflicted = conflictFiles.has(filePath);
  const tenantSensitive = isTenantSensitiveFile(filePath);
  const kind = classifyKind(filePath);

  if (tenantSensitive) {
    return {
      filePath,
      riskLevel: 'HIGH',
      kind,
      conflicted,
      tenantSensitive: true,
      reason: conflicted
        ? 'Conflict is in a tenant-sensitive MasjidWeb seam where unsafe resolution could expose or corrupt tenant data.'
        : 'Change touches tenant-sensitive MasjidWeb/Ycode core behavior that needs human review.',
      autopilotAction: conflicted
        ? 'Block automatic repair; require developer resolution and tenant-safety verification.'
        : 'Allow CI to continue but require tenant-sensitive review before approval.',
    };
  }

  if (conflicted) {
    if (kind === 'lockfile') {
      return {
        filePath,
        riskLevel: 'MEDIUM',
        kind,
        conflicted,
        tenantSensitive: false,
        reason: 'Lockfile conflicts are usually mechanical, but the regenerated lockfile must still be checked in CI.',
        autopilotAction: 'Regenerate package-lock.json mechanically, then run the guard and build checks.',
      };
    }
    return {
      filePath,
      riskLevel: 'MEDIUM',
      kind,
      conflicted,
      tenantSensitive: false,
      reason: 'Conflict is outside known tenant seams, but automatic merge output still needs verification.',
      autopilotAction: 'Retry deterministic repair or ask a developer if conflict markers remain.',
    };
  }

  if (kind === 'core-config' || startsWithAny(filePath, MEDIUM_RISK_PREFIXES)) {
    return {
      filePath,
      riskLevel: 'MEDIUM',
      kind,
      conflicted,
      tenantSensitive: false,
      reason: 'Change affects update tooling, workflow, UI, or shared runtime behavior.',
      autopilotAction: 'Run normal CI and review the change summary before approval.',
    };
  }

  return {
    filePath,
    riskLevel: 'LOW',
    kind,
    conflicted,
    tenantSensitive: false,
    reason: 'No tenant-sensitive path or merge conflict detected.',
    autopilotAction: 'Proceed through normal CI.',
  };
}

function highestRisk(classifications: UpdateFileClassification[]): AutopilotRiskLevel {
  if (classifications.some((item) => item.riskLevel === 'HIGH')) return 'HIGH';
  if (classifications.some((item) => item.riskLevel === 'MEDIUM')) return 'MEDIUM';
  return 'LOW';
}

function buildBlockedReasons(classifications: UpdateFileClassification[]): string[] {
  const reasons: string[] = [];
  const highRiskConflicts = classifications.filter((item) => item.conflicted && item.riskLevel === 'HIGH');
  const otherConflicts = classifications.filter((item) => item.conflicted && item.riskLevel !== 'HIGH');

  if (highRiskConflicts.length > 0) {
    reasons.push(
      `Autopilot blocked this update to protect tenant data: ${highRiskConflicts.length} conflict(s) are in tenant-sensitive files.`,
    );
  }
  if (otherConflicts.length > 0) {
    reasons.push(`${otherConflicts.length} conflicted file(s) still need deterministic repair or developer review.`);
  }
  return reasons;
}

function buildNextActions(
  status: AutopilotStatus,
  classifications: UpdateFileClassification[],
): string[] {
  if (status === 'blocked') {
    const hasLockfile = classifications.some((item) => item.conflicted && item.kind === 'lockfile');
    const hasHighRisk = classifications.some((item) => item.conflicted && item.riskLevel === 'HIGH');
    const actions = ['Do not approve this update while status is red.'];
    if (hasLockfile) {
      actions.push('Retry Autopilot to regenerate package-lock.json mechanically.');
    }
    if (hasHighRisk) {
      actions.push('Developer required: resolve tenant-sensitive conflicts and run tenant-scope verification.');
    }
    actions.push('Defer update if a developer is not available today.');
    return actions;
  }

  if (status === 'review_required') {
    return [
      'Preview the deploy preview before approval.',
      'Review tenant-sensitive files listed in the report.',
      'Run the tenant safety tests and build before approval.',
    ];
  }

  return ['Run normal CI and preview checks before approval.'];
}

function buildHumanSummary(
  status: AutopilotStatus,
  riskLevel: AutopilotRiskLevel,
  blockedReasons: string[],
): string {
  if (status === 'blocked') {
    return blockedReasons[0] ?? 'Autopilot blocked this update because conflicts remain.';
  }
  if (status === 'review_required') {
    return `Autopilot classified this update as ${riskLevel} risk. It may continue through CI, but approval needs review.`;
  }
  return 'Autopilot found no tenant-sensitive conflicts. Continue with normal CI and preview checks.';
}

export function classifyUpdateRisk(
  changedFiles: string[],
  conflictFiles: string[] = [],
): UpdateSafetyResult {
  const allFiles = uniqueSorted([...changedFiles, ...conflictFiles]);
  const conflictSet = new Set(uniqueSorted(conflictFiles));
  const classifications = allFiles.map((filePath) => classifyFile(filePath, conflictSet));
  const riskLevel = highestRisk(classifications);
  const blockedReasons = buildBlockedReasons(classifications);
  const hasConflicts = conflictSet.size > 0;
  const hasHighRiskFiles = classifications.some((item) => item.riskLevel === 'HIGH');
  const status: AutopilotStatus = hasConflicts ? 'blocked' : hasHighRiskFiles ? 'review_required' : 'safe';
  const level: LegacyUpdateRiskLevel = status === 'blocked' ? 'blocked' : hasHighRiskFiles ? 'high' : 'safe';
  const highRiskFiles = classifications
    .filter((item) => item.riskLevel === 'HIGH')
    .map((item) => item.filePath);
  const mediumRiskFiles = classifications
    .filter((item) => item.riskLevel === 'MEDIUM')
    .map((item) => item.filePath);
  const lowRiskFiles = classifications
    .filter((item) => item.riskLevel === 'LOW')
    .map((item) => item.filePath);

  return {
    level,
    status,
    riskLevel,
    changedFiles: uniqueSorted(changedFiles),
    highRiskFiles,
    mediumRiskFiles,
    lowRiskFiles,
    safeFiles: classifications
      .filter((item) => item.riskLevel !== 'HIGH')
      .map((item) => item.filePath),
    conflictFiles: uniqueSorted(conflictFiles),
    classifications,
    blockedReasons,
    nextActions: buildNextActions(status, classifications),
    needsDeveloperReview: status !== 'safe',
    humanSummary: buildHumanSummary(status, riskLevel, blockedReasons),
  };
}

function formatFileList(title: string, files: string[]): string[] {
  if (files.length === 0) return [];
  return ['', title, ...files.map((filePath) => `- ${filePath}`)];
}

export function formatUpdateSafetyReport(result: UpdateSafetyResult): string {
  const lines = [
    '# Core Update Autopilot v2 report',
    '',
    `Status: ${result.status}`,
    `Risk: ${result.riskLevel}`,
    `Legacy status: ${result.level}`,
    '',
    result.humanSummary,
  ];

  if (result.blockedReasons.length > 0) {
    lines.push('', 'Blocked reason:', ...result.blockedReasons.map((reason) => `- ${reason}`));
  }

  if (result.nextActions.length > 0) {
    lines.push('', 'Next action:', ...result.nextActions.map((action) => `- ${action}`));
  }

  lines.push(
    ...formatFileList('Conflict files:', result.conflictFiles),
    ...formatFileList('HIGH risk tenant-sensitive files:', result.highRiskFiles),
    ...formatFileList('MEDIUM risk files:', result.mediumRiskFiles),
    ...formatFileList('LOW risk files:', result.lowRiskFiles),
  );

  if (result.classifications.length > 0) {
    lines.push('', 'File classifications:');
    for (const item of result.classifications) {
      lines.push(
        `- ${item.filePath} — ${item.riskLevel} (${item.kind})${item.conflicted ? '; conflicted' : ''}: ${item.autopilotAction}`,
      );
    }
  }

  return lines.join('\n');
}
