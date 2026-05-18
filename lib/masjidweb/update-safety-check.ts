export type UpdateRiskLevel = 'safe' | 'high' | 'blocked';

export interface UpdateSafetyResult {
  level: UpdateRiskLevel;
  changedFiles: string[];
  highRiskFiles: string[];
  safeFiles: string[];
  conflictFiles: string[];
  needsDeveloperReview: boolean;
}

const HIGH_RISK_PREFIXES = [
  'app/(builder)/ycode/api/',
  'app/(builder)/ycode/mcp/',
  'app/(site)/api/',
  'app/(site)/',
  'database/migrations/',
  'lib/masjidweb/',
  'lib/mcp/',
  'lib/repositories/',
  'lib/services/cacheService',
  'lib/services/collectionService',
  'lib/services/pageService',
  'lib/supabase-',
  'proxy.ts',
  'next.config.ts',
  'netlify.toml',
  'stores/useAuthStore.ts',
];

function isHighRiskFile(filePath: string): boolean {
  return HIGH_RISK_PREFIXES.some((prefix) => filePath.startsWith(prefix));
}

export function classifyUpdateRisk(
  changedFiles: string[],
  conflictFiles: string[] = []
): UpdateSafetyResult {
  const highRiskFiles = changedFiles.filter(isHighRiskFile);
  const safeFiles = changedFiles.filter((filePath) => !isHighRiskFile(filePath));
  const hasConflicts = conflictFiles.length > 0;
  const hasHighRiskFiles = highRiskFiles.length > 0;

  return {
    level: hasConflicts ? 'blocked' : hasHighRiskFiles ? 'high' : 'safe',
    changedFiles,
    highRiskFiles,
    safeFiles,
    conflictFiles,
    needsDeveloperReview: hasConflicts || hasHighRiskFiles,
  };
}

export function formatUpdateSafetyReport(result: UpdateSafetyResult): string {
  const lines = [
    `Status: ${result.level}`,
    '',
  ];

  if (result.level === 'blocked') {
    lines.push('This update has merge conflicts and must be reviewed before it can be merged.');
  } else if (result.level === 'high') {
    lines.push('This update touches tenant-sensitive MasjidWeb/Ycode core files. Review is required before merge.');
  } else {
    lines.push('No tenant-sensitive files were detected by the automated safety check.');
  }

  if (result.conflictFiles.length > 0) {
    lines.push('', 'Conflict files:', ...result.conflictFiles.map((filePath) => `- ${filePath}`));
  }

  if (result.highRiskFiles.length > 0) {
    lines.push('', 'Tenant-sensitive files:', ...result.highRiskFiles.map((filePath) => `- ${filePath}`));
  }

  if (result.safeFiles.length > 0) {
    lines.push('', 'Other changed files:', ...result.safeFiles.map((filePath) => `- ${filePath}`));
  }

  return lines.join('\n');
}
