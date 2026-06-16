import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import {
  classifyUpdateRisk,
  formatUpdateSafetyReport,
  type UpdateSafetyResult,
} from '../lib/masjidweb/update-safety-check';
import {
  hasConflictMarkers,
  invariantChecksForFile,
  type AutopilotInvariantCheck,
} from '../lib/masjidweb/autopilot-tenant-invariants';

const TENANT_GUARD_FILES = [
  'app/(builder)/ycode/api/publish/route.ts',
  'lib/repositories/collectionItemRepository.ts',
  'lib/repositories/collectionItemValueRepository.ts',
  'lib/repositories/pageRepository.ts',
  'lib/repositories/collectionFieldRepository.ts',
  'lib/page-fetcher.ts',
  'lib/services/collectionService.ts',
  'proxy.ts',
  'lib/supabase-cookie-domain.ts',
  'lib/supabase-browser.ts',
  'lib/supabase-route-client.ts',
];

function listAllowFailure(command: string): string[] {
  try {
    return execSync(command, { encoding: 'utf8' })
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

function readChangedOrGuardedFiles(): string[] {
  const changed = listAllowFailure('git diff --name-only origin/main...HEAD');
  const conflicted = listAllowFailure('git diff --name-only --diff-filter=U');
  return [...new Set([...changed, ...conflicted, ...TENANT_GUARD_FILES])].sort();
}

function main(): void {
  const outputPath = process.env.AUTOPILOT_GUARD_REPORT_PATH;
  const jsonOutputPath = process.env.AUTOPILOT_GUARD_REPORT_JSON_PATH;
  const files = readChangedOrGuardedFiles();
  const conflictFiles = listAllowFailure('git diff --name-only --diff-filter=U');
  const changedFiles = listAllowFailure('git diff --name-only origin/main...HEAD');
  const safety: UpdateSafetyResult = classifyUpdateRisk(changedFiles, conflictFiles);
  const checks: AutopilotInvariantCheck[] = [];
  const conflictMarkerFiles: string[] = [];

  for (const filePath of files) {
    if (!existsSync(filePath)) continue;
    const content = readFileSync(filePath, 'utf8');
    if (hasConflictMarkers(content)) {
      conflictMarkerFiles.push(filePath);
    }
    checks.push(...invariantChecksForFile(filePath, content));
  }

  const failedChecks = checks.filter((check) => !check.ok);
  const lines = [
    '# Core Update Autopilot v2 guard',
    '',
    formatUpdateSafetyReport(safety),
    '',
    '## Deterministic guard checks',
    '',
    `- Conflict marker files: **${conflictMarkerFiles.length}**`,
    `- Tenant invariant checks: **${checks.length}**`,
    `- Failed tenant invariant checks: **${failedChecks.length}**`,
  ];

  if (conflictMarkerFiles.length > 0) {
    lines.push('', '### Conflict markers still present', ...conflictMarkerFiles.map((file) => `- ${file}`));
  }

  if (failedChecks.length > 0) {
    lines.push('', '### Failed invariant checks');
    for (const check of failedChecks) {
      lines.push(`- ${check.filePath}: ${check.name} — ${check.message}`);
    }
  }

  if (outputPath) {
    writeFileSync(outputPath, `${lines.join('\n')}\n`);
  }

  if (jsonOutputPath) {
    writeFileSync(
      jsonOutputPath,
      `${JSON.stringify({ safety, conflictMarkerFiles, checks, failedChecks }, null, 2)}\n`,
    );
  }

  console.log(lines.join('\n'));

  if (conflictMarkerFiles.length > 0 || failedChecks.length > 0 || safety.status === 'blocked') {
    process.exit(2);
  }
}

main();
