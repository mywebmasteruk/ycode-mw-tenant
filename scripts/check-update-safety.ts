import { execSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { classifyUpdateRisk, formatUpdateSafetyReport } from '../lib/masjidweb/update-safety-check';

function list(command: string): string[] {
  return execSync(command, { encoding: 'utf8' })
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

const baseRef = process.env.UPDATE_BASE_REF || 'origin/main';
const outputPath = process.env.UPDATE_SAFETY_REPORT_PATH;
const changedFiles = list(`git diff --name-only ${baseRef}...HEAD`);
const conflictFiles = list('git diff --name-only --diff-filter=U');
const result = classifyUpdateRisk(changedFiles, conflictFiles);
const report = formatUpdateSafetyReport(result);

console.log(report);

if (outputPath) {
  writeFileSync(outputPath, `${report}\n`);
}

if (process.env.GITHUB_OUTPUT) {
  writeFileSync(
    process.env.GITHUB_OUTPUT,
    [
      `risk_level=${result.level}`,
      `needs_developer_review=${result.needsDeveloperReview ? 'true' : 'false'}`,
      `high_risk_count=${result.highRiskFiles.length}`,
      `conflict_count=${result.conflictFiles.length}`,
    ].join('\n') + '\n',
    { flag: 'a' }
  );
}

if (result.conflictFiles.length > 0) {
  process.exit(2);
}
