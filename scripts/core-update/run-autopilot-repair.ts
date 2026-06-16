import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  formatAutopilotRepairMarkdown,
  runAutopilotRepair,
} from '../../lib/masjidweb/autopilot-repair';

const repoRoot = join(__dirname, '..', '..');
const reportPath = process.env.AUTOPILOT_REPAIR_REPORT_PATH || '/tmp/autopilot-repair-report.md';
const jsonReportPath = process.env.AUTOPILOT_REPAIR_REPORT_JSON_PATH || '/tmp/autopilot-repair-report.json';

const report = runAutopilotRepair({
  repoRoot,
  reportPath,
  jsonReportPath,
});

const markdown = formatAutopilotRepairMarkdown(report);
console.log(markdown);

if (process.env.GITHUB_OUTPUT) {
  appendFileSync(
    process.env.GITHUB_OUTPUT,
    [
      `status=${report.status}`,
      `conflict_count=${report.conflictFiles.length}`,
      `repaired_count=${report.repairedFiles.length}`,
      `blocked_count=${report.blockedFiles.length}`,
      `failed_count=${report.failedFiles.length}`,
      `known_resolver_unavailable_count=${report.blockedByReason['known-resolver-unavailable'].length}`,
      `tenant_invariant_failed_count=${report.blockedByReason['tenant-invariant-failed'].length}`,
      `conflict_markers_remain_count=${report.blockedByReason['conflict-markers-remain'].length}`,
      `dashboard_next_action=${report.dashboardNextAction}`,
    ].join('\n') + '\n',
  );
}

if (process.env.GITHUB_STEP_SUMMARY) {
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, markdown);
}

if (report.status !== 'success') {
  process.exit(2);
}
