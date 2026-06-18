import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  COPILOT_ESCALATION_MARKER,
  buildCopilotEscalationPrompt,
  readOptionalJsonFile,
  readOptionalTextFile,
} from '../../lib/masjidweb/copilot-escalation';

interface CliOptions {
  prNumber: string;
  reportPath?: string;
  jsonReportPath?: string;
  blockedFiles: string[];
  artifactUrl?: string;
  workflowRunUrl?: string;
  repository?: string;
  dryRun: boolean;
  createIssue: boolean;
  assignCopilot: boolean;
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    prNumber: process.env.PR_NUMBER || '',
    reportPath: process.env.AUTOPILOT_REPAIR_REPORT_PATH,
    jsonReportPath: process.env.AUTOPILOT_REPAIR_REPORT_JSON_PATH,
    blockedFiles: (process.env.BLOCKED_FILES || '').split(',').map((file) => file.trim()).filter(Boolean),
    artifactUrl: process.env.AUTOPILOT_ARTIFACT_URL,
    workflowRunUrl: process.env.WORKFLOW_RUN_URL,
    repository: process.env.GITHUB_REPOSITORY,
    dryRun: process.env.COPILOT_ESCALATION_DRY_RUN === 'true',
    createIssue: process.env.COPILOT_ESCALATION_CREATE_ISSUE === 'true',
    assignCopilot: process.env.COPILOT_ESCALATION_ASSIGN_COPILOT === 'true',
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];
    switch (arg) {
      case '--pr':
      case '--pr-number':
        options.prNumber = next || '';
        index += 1;
        break;
      case '--report':
        options.reportPath = next;
        index += 1;
        break;
      case '--json-report':
        options.jsonReportPath = next;
        index += 1;
        break;
      case '--blocked-file':
        if (next) options.blockedFiles.push(next);
        index += 1;
        break;
      case '--blocked-files':
        if (next) options.blockedFiles.push(...next.split(',').map((file) => file.trim()).filter(Boolean));
        index += 1;
        break;
      case '--artifact-url':
        options.artifactUrl = next;
        index += 1;
        break;
      case '--workflow-run-url':
        options.workflowRunUrl = next;
        index += 1;
        break;
      case '--repo':
        options.repository = next;
        index += 1;
        break;
      case '--dry-run':
        options.dryRun = true;
        break;
      case '--create-issue':
        options.createIssue = true;
        break;
      case '--assign-copilot':
        options.assignCopilot = true;
        options.createIssue = true;
        break;
      default:
        if (arg?.startsWith('--')) {
          throw new Error(`Unknown argument: ${arg}`);
        }
    }
  }

  return options;
}

function runGh(args: string[], input?: string): string {
  return execFileSync('gh', args, {
    encoding: 'utf8',
    input,
    stdio: input === undefined ? ['ignore', 'pipe', 'pipe'] : ['pipe', 'pipe', 'pipe'],
  }).trim();
}

function repoEndpoint(repository?: string): string {
  return `repos/${repository || ':owner/:repo'}`;
}

function ghRepoArgs(repository?: string): string[] {
  return repository ? ['--repo', repository] : [];
}

function existingEscalationCommentId(prNumber: string, repository?: string): string | null {
  const output = runGh([
    'api',
    `${repoEndpoint(repository)}/issues/${prNumber}/comments`,
    '--paginate',
    '--jq',
    `.[] | select(.body | contains("${COPILOT_ESCALATION_MARKER}")) | .id`,
  ]);
  return output.split('\n').map((line) => line.trim()).filter(Boolean)[0] ?? null;
}

function createOrUpdatePrComment(options: CliOptions, body: string): string {
  const existingCommentId = existingEscalationCommentId(options.prNumber, options.repository);
  if (existingCommentId) {
    runGh([
      'api',
      '--method',
      'PATCH',
      `${repoEndpoint(options.repository)}/issues/comments/${existingCommentId}`,
      '-f',
      `body=${body}`,
    ]);
    return `updated PR comment ${existingCommentId}`;
  }

  runGh([
    'api',
    '--method',
    'POST',
    `${repoEndpoint(options.repository)}/issues/${options.prNumber}/comments`,
    '-f',
    `body=${body}`,
  ]);
  return 'created PR comment';
}

function ensureLabels(repository?: string): string[] {
  const labels = ['safe-ycode-update', 'needs-developer-review', 'copilot-escalation'];
  for (const label of labels) {
    const color = label === 'copilot-escalation' ? '5319E7' : label === 'safe-ycode-update' ? '0E8A16' : 'B60205';
    const description = label === 'copilot-escalation'
      ? 'Safe-update task prepared for optional GitHub Copilot coding agent assignment'
      : label;
    try {
      runGh(['label', 'create', label, ...ghRepoArgs(repository), '--color', color, '--description', description]);
    } catch {
      // Existing labels are fine.
    }
  }
  return labels;
}

function existingEscalationIssueNumber(options: CliOptions): string | null {
  const output = runGh([
    'issue',
    'list',
    ...ghRepoArgs(options.repository),
    '--state',
    'open',
    '--search',
    `${COPILOT_ESCALATION_MARKER} "PR #${options.prNumber}" in:body`,
    '--json',
    'number',
    '--jq',
    '.[0].number // empty',
  ]);
  return output.trim() || null;
}

function createOrUpdateIssue(options: CliOptions, bodyPath: string, body: string): string {
  const labels = ensureLabels(options.repository);
  const existingIssueNumber = existingEscalationIssueNumber(options);
  if (existingIssueNumber) {
    runGh([
      'api',
      '--method',
      'PATCH',
      `${repoEndpoint(options.repository)}/issues/${existingIssueNumber}`,
      '-f',
      `body=${body}`,
      '-f',
      `title=Copilot repair task for safe-update PR #${options.prNumber}`,
    ]);
    if (options.assignCopilot) {
      runGh(['issue', 'edit', existingIssueNumber, ...ghRepoArgs(options.repository), '--add-assignee', '@copilot']);
    }
    return runGh(['issue', 'view', existingIssueNumber, ...ghRepoArgs(options.repository), '--json', 'url', '--jq', '.url']);
  }

  const args = [
    'issue',
    'create',
    ...ghRepoArgs(options.repository),
    '--title',
    `Copilot repair task for safe-update PR #${options.prNumber}`,
    '--body-file',
    bodyPath,
    '--label',
    labels.join(','),
  ];
  if (options.assignCopilot) args.push('--assignee', '@copilot');
  return runGh(args);
}

function appendOutput(name: string, value: string): void {
  if (!process.env.GITHUB_OUTPUT) return;
  appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${value}\n`);
}

function main(): void {
  const options = parseArgs(process.argv.slice(2));
  if (!options.prNumber) throw new Error('Missing required PR number. Use --pr-number or PR_NUMBER.');

  const reportMarkdown = readOptionalTextFile(options.reportPath);
  const reportJson = readOptionalJsonFile(options.jsonReportPath);
  const prompt = buildCopilotEscalationPrompt({
    prNumber: options.prNumber,
    blockedFiles: options.blockedFiles,
    reportMarkdown,
    reportJson,
    artifactUrl: options.artifactUrl,
    workflowRunUrl: options.workflowRunUrl,
    repository: options.repository,
  });

  const outputDir = mkdtempSync(join(tmpdir(), 'copilot-escalation-'));
  const promptPath = join(outputDir, 'copilot-escalation.md');
  writeFileSync(promptPath, `${prompt}\n`);
  appendOutput('prompt_path', promptPath);

  if (options.dryRun) {
    console.log(prompt);
    appendOutput('mode', 'dry-run');
    return;
  }

  const commentResult = createOrUpdatePrComment(options, prompt);
  appendOutput('comment_result', commentResult);

  if (options.createIssue) {
    const issueUrl = createOrUpdateIssue(options, promptPath, prompt);
    console.log(`Created or updated Copilot escalation issue: ${issueUrl}`);
    appendOutput('issue_url', issueUrl);
    appendOutput('mode', options.assignCopilot ? 'issue-assigned-to-copilot' : 'issue-created-or-updated');
    return;
  }

  console.log(`Copilot escalation ${commentResult}.`);
  appendOutput('mode', 'pr-comment');
}

main();
