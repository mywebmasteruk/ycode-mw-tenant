import { execSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import {
  classifyUpdateRisk,
  formatUpdateSafetyReport,
  type UpdateSafetyResult,
} from '../lib/masjidweb/update-safety-check';

function list(command: string): string[] {
  return execSync(command, { encoding: 'utf8' })
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

function listAllowFailure(command: string): string[] {
  try {
    return list(command);
  } catch {
    return [];
  }
}

function writeJsonReport(outputPath: string, result: UpdateSafetyResult): void {
  writeFileSync(outputPath, `${JSON.stringify(result, null, 2)}\n`);
}

function appendGithubOutput(result: UpdateSafetyResult): void {
  if (!process.env.GITHUB_OUTPUT) return;
  writeFileSync(
    process.env.GITHUB_OUTPUT,
    [
      `risk_level=${result.level}`,
      `autopilot_risk=${result.riskLevel}`,
      `autopilot_status=${result.status}`,
      `needs_developer_review=${result.needsDeveloperReview ? 'true' : 'false'}`,
      `high_risk_count=${result.highRiskFiles.length}`,
      `medium_risk_count=${result.mediumRiskFiles.length}`,
      `conflict_count=${result.conflictFiles.length}`,
    ].join('\n') + '\n',
    { flag: 'a' },
  );
}

const baseRef = process.env.UPDATE_BASE_REF || 'origin/main';
const outputPath = process.env.UPDATE_SAFETY_REPORT_PATH;
const jsonOutputPath = process.env.UPDATE_SAFETY_REPORT_JSON_PATH;
const changedFiles = listAllowFailure(`git diff --name-only ${baseRef}...HEAD`);
const conflictFiles = listAllowFailure('git diff --name-only --diff-filter=U');
const result = classifyUpdateRisk(changedFiles, conflictFiles);
const report = formatUpdateSafetyReport(result);

console.log(report);

if (outputPath) {
  writeFileSync(outputPath, `${report}\n`);
}

if (jsonOutputPath) {
  writeJsonReport(jsonOutputPath, result);
}

appendGithubOutput(result);

if (result.status === 'blocked') {
  process.exit(2);
}
