import { checkForUpdates } from '@/lib/updates/check-updates';

const SAFE_UPDATE_WORKFLOW = 'sync-upstream.yml';
const SAFE_UPDATE_LABEL = 'safe-ycode-update';

export type AdminUpdateStatus =
  | 'up_to_date'
  | 'update_available'
  | 'preparing'
  | 'checks_running'
  | 'safe_to_review'
  | 'needs_safety_review'
  | 'blocked'
  | 'failed_checks'
  | 'setup_required'
  | 'unknown_error';

export type PullRequestCheckStatus = 'pending' | 'success' | 'failure' | 'unknown';

export interface SafeUpdatePullRequest {
  number: number;
  url: string;
  title: string;
  draft: boolean;
  labels: string[];
  mergeable: boolean | null;
  checksStatus: PullRequestCheckStatus;
  hasConflicts?: boolean;
}

export interface AdminUpdateStatusInput {
  configured: boolean;
  updateAvailable: boolean;
  currentVersion: string;
  latestVersion?: string;
  pullRequest?: SafeUpdatePullRequest | null;
  workflowRun?: {
    status: 'queued' | 'in_progress' | 'completed' | 'unknown';
    conclusion: string | null;
    url?: string;
  } | null;
  error?: string;
}

export interface AdminUpdateCenterStatus {
  ok: boolean;
  status: AdminUpdateStatus;
  title: string;
  description: string;
  currentVersion: string;
  latestVersion?: string;
  canPrepare: boolean;
  primaryActionLabel?: string;
  reviewUrl?: string;
  workflowUrl?: string;
  productionProtected: boolean;
  technicalDetails?: string;
}

interface GitHubConfig {
  repo: string | null;
  token: string | null;
}

interface GitHubPullSearchItem {
  number: number;
  html_url: string;
  title: string;
  draft?: boolean;
  labels?: Array<{ name?: string }>;
  pull_request?: unknown;
}

interface GitHubPullResponse {
  number: number;
  html_url: string;
  title: string;
  draft: boolean;
  mergeable: boolean | null;
  mergeable_state?: string;
  labels?: Array<{ name?: string }>;
  head?: { sha?: string };
}

interface GitHubCheckRunsResponse {
  check_runs?: Array<{ status?: string; conclusion?: string | null }>;
}

interface GitHubWorkflowRunsResponse {
  workflow_runs?: Array<{
    html_url?: string;
    status?: string;
    conclusion?: string | null;
  }>;
}

function getGitHubConfig(): GitHubConfig {
  const repo =
    process.env.MASJIDWEB_UPDATE_REPO ||
    (process.env.VERCEL_GIT_REPO_OWNER && process.env.VERCEL_GIT_REPO_SLUG
      ? `${process.env.VERCEL_GIT_REPO_OWNER}/${process.env.VERCEL_GIT_REPO_SLUG}`
      : null);

  return {
    repo,
    token: process.env.MASJIDWEB_UPDATE_GITHUB_TOKEN || null,
  };
}

function githubHeaders(token: string): HeadersInit {
  return {
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${token}`,
    'User-Agent': 'MasjidWeb-Update-Center',
    'X-GitHub-Api-Version': '2022-11-28',
  };
}

function checksStatusFromRuns(runs: GitHubCheckRunsResponse): PullRequestCheckStatus {
  const checkRuns = runs.check_runs || [];

  if (checkRuns.length === 0) {
    return 'unknown';
  }

  if (checkRuns.some((run) => run.conclusion === 'failure' || run.conclusion === 'cancelled' || run.conclusion === 'timed_out')) {
    return 'failure';
  }

  if (checkRuns.some((run) => run.status !== 'completed')) {
    return 'pending';
  }

  if (checkRuns.every((run) => run.conclusion === 'success' || run.conclusion === 'neutral' || run.conclusion === 'skipped')) {
    return 'success';
  }

  return 'unknown';
}

async function fetchGitHubJson<T>(url: string, token: string): Promise<T> {
  const response = await fetch(url, {
    headers: githubHeaders(token),
    cache: 'no-store',
  });

  if (!response.ok) {
    throw new Error(`GitHub request failed: ${response.status}`);
  }

  return response.json() as Promise<T>;
}

async function getLatestSafeUpdatePullRequest(repo: string, token: string): Promise<SafeUpdatePullRequest | null> {
  const searchParams = new URLSearchParams({
    q: `repo:${repo} is:pr is:open label:${SAFE_UPDATE_LABEL}`,
    sort: 'updated',
    order: 'desc',
    per_page: '1',
  });
  const search = await fetchGitHubJson<{ items?: GitHubPullSearchItem[] }>(
    `https://api.github.com/search/issues?${searchParams.toString()}`,
    token
  );
  const item = search.items?.[0];

  if (!item) {
    return null;
  }

  const pull = await fetchGitHubJson<GitHubPullResponse>(
    `https://api.github.com/repos/${repo}/pulls/${item.number}`,
    token
  );
  const labels = (pull.labels || item.labels || [])
    .map((label) => label.name)
    .filter((name): name is string => Boolean(name));

  let checksStatus: PullRequestCheckStatus = 'unknown';
  if (pull.head?.sha) {
    const checkRuns = await fetchGitHubJson<GitHubCheckRunsResponse>(
      `https://api.github.com/repos/${repo}/commits/${pull.head.sha}/check-runs`,
      token
    );
    checksStatus = checksStatusFromRuns(checkRuns);
  }

  return {
    number: pull.number,
    url: pull.html_url,
    title: pull.title,
    draft: pull.draft,
    labels,
    mergeable: pull.mergeable,
    checksStatus,
    hasConflicts: pull.mergeable_state === 'dirty',
  };
}

async function getLatestWorkflowRun(repo: string, token: string): Promise<AdminUpdateStatusInput['workflowRun']> {
  const runs = await fetchGitHubJson<GitHubWorkflowRunsResponse>(
    `https://api.github.com/repos/${repo}/actions/workflows/${SAFE_UPDATE_WORKFLOW}/runs?per_page=1`,
    token
  );
  const run = runs.workflow_runs?.[0];

  if (!run) {
    return null;
  }

  const status = run.status === 'queued' || run.status === 'in_progress' || run.status === 'completed'
    ? run.status
    : 'unknown';

  return {
    status,
    conclusion: run.conclusion || null,
    url: run.html_url,
  };
}

export function mapAdminUpdateStatus(input: AdminUpdateStatusInput): AdminUpdateCenterStatus {
  const base = {
    ok: !input.error,
    currentVersion: input.currentVersion,
    latestVersion: input.latestVersion,
    productionProtected: true,
    technicalDetails: input.error,
  };

  if (!input.configured) {
    return {
      ...base,
      status: 'setup_required',
      title: 'Setup needed before updates can be prepared',
      description: 'The admin can see that an update exists, but the secure GitHub connection is not configured yet. Production has not been changed.',
      canPrepare: false,
    };
  }

  if (!input.updateAvailable) {
    return {
      ...base,
      status: 'up_to_date',
      title: 'You are up to date',
      description: 'The MasjidWeb builder is already using the latest known Ycode core version.',
      canPrepare: false,
    };
  }

  const pr = input.pullRequest;

  if (pr?.hasConflicts) {
    return {
      ...base,
      status: 'blocked',
      title: 'This update is blocked',
      description: 'The update has conflicts with MasjidWeb changes. A developer must resolve those conflicts before it can move forward.',
      canPrepare: false,
      reviewUrl: pr.url,
    };
  }

  if (pr?.checksStatus === 'failure') {
    return {
      ...base,
      status: 'failed_checks',
      title: 'Automated checks failed',
      description: 'The update was prepared, but automated safety checks found a problem. Do not approve it until a developer reviews it.',
      canPrepare: false,
      reviewUrl: pr.url,
    };
  }

  if (pr?.draft || pr?.labels.includes('needs-developer-review') || pr?.labels.includes('tenant-sensitive-update')) {
    return {
      ...base,
      status: 'needs_safety_review',
      title: 'This update needs safety review',
      description: 'This update touches sensitive MasjidWeb areas such as tenants, publishing, login, or database changes. Ask a developer to review before approving.',
      canPrepare: false,
      reviewUrl: pr.url,
    };
  }

  if (pr?.checksStatus === 'pending' || pr?.checksStatus === 'unknown') {
    return {
      ...base,
      status: 'checks_running',
      title: 'Update prepared and checks are running',
      description: 'The update has been prepared safely. Automated checks are still running, so production has not changed.',
      canPrepare: false,
      reviewUrl: pr.url,
    };
  }

  if (pr?.checksStatus === 'success' && pr.mergeable !== false) {
    return {
      ...base,
      status: 'safe_to_review',
      title: 'Update prepared and checks passed',
      description: 'The update PR is ready for final review. Production will still only change after the protected review path is approved and merged.',
      canPrepare: false,
      reviewUrl: pr.url,
    };
  }

  if (input.workflowRun?.status === 'queued' || input.workflowRun?.status === 'in_progress') {
    return {
      ...base,
      status: 'preparing',
      title: 'Preparing safe update',
      description: 'MasjidWeb is preparing a safe update branch and safety report. Production has not changed.',
      canPrepare: false,
      workflowUrl: input.workflowRun.url,
    };
  }

  return {
    ...base,
    status: 'update_available',
    title: 'A new core update is available',
    description: 'Click Prepare safe update. This creates a protected review update and does not change production.',
    canPrepare: true,
    primaryActionLabel: 'Prepare safe update',
  };
}

export async function getAdminUpdateCenterStatus(currentVersion: string): Promise<AdminUpdateCenterStatus> {
  const updateInfo = await checkForUpdates(currentVersion);
  const config = getGitHubConfig();
  const configured = Boolean(config.repo && config.token);

  if (!configured) {
    return mapAdminUpdateStatus({
      configured: false,
      updateAvailable: updateInfo.available,
      currentVersion: updateInfo.currentVersion,
      latestVersion: updateInfo.latestVersion,
    });
  }

  try {
    const [pullRequest, workflowRun] = await Promise.all([
      getLatestSafeUpdatePullRequest(config.repo as string, config.token as string),
      getLatestWorkflowRun(config.repo as string, config.token as string),
    ]);

    return mapAdminUpdateStatus({
      configured: true,
      updateAvailable: updateInfo.available,
      currentVersion: updateInfo.currentVersion,
      latestVersion: updateInfo.latestVersion,
      pullRequest,
      workflowRun,
    });
  } catch (error) {
    return {
      ok: false,
      status: 'unknown_error',
      title: 'Unable to read update status',
      description: 'MasjidWeb could not read the safe update status from GitHub. Production has not changed.',
      currentVersion: updateInfo.currentVersion,
      latestVersion: updateInfo.latestVersion,
      canPrepare: false,
      productionProtected: true,
      technicalDetails: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function prepareSafeUpdate(): Promise<{ ok: true; message: string }> {
  const config = getGitHubConfig();

  if (!config.repo || !config.token) {
    throw new Error('MASJIDWEB_UPDATE_REPO or MASJIDWEB_UPDATE_GITHUB_TOKEN is not configured');
  }

  const response = await fetch(
    `https://api.github.com/repos/${config.repo}/actions/workflows/${SAFE_UPDATE_WORKFLOW}/dispatches`,
    {
      method: 'POST',
      headers: githubHeaders(config.token),
      body: JSON.stringify({ ref: 'main' }),
      cache: 'no-store',
    }
  );

  if (!response.ok) {
    throw new Error(`Unable to start safe update workflow: ${response.status}`);
  }

  return {
    ok: true,
    message: 'Safe update preparation has started. Production has not changed.',
  };
}
