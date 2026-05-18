/**
 * Check for Ycode updates from the official repository.
 * Extracted for reuse and to allow cloud overlay to return "no update" in hosted deployments.
 */

const UPSTREAM_REPO = 'ycode/ycode'; // Official Ycode repo

export interface CheckUpdatesResult {
  available: boolean;
  currentVersion: string;
  latestVersion?: string;
  releaseUrl?: string;
  releaseNotes?: string | null;
  publishedAt?: string | null;
  updateInstructions?: {
    method: 'github-sync' | 'git-pull' | 'manual';
    steps: string[];
    autoSyncUrl?: string;
  };
  message?: string;
  error?: string;
}

/**
 * Simple version comparison (semantic versioning)
 * Returns: 1 if a > b, -1 if a < b, 0 if equal
 */
function compareVersions(a: string, b: string): number {
  const aParts = a.split('.').map(Number);
  const bParts = b.split('.').map(Number);

  for (let i = 0; i < Math.max(aParts.length, bParts.length); i++) {
    const aNum = aParts[i] || 0;
    const bNum = bParts[i] || 0;

    if (aNum > bNum) return 1;
    if (aNum < bNum) return -1;
  }

  return 0;
}

/**
 * Check for updates from the official Ycode repository
 */
export async function checkForUpdates(currentVersion: string): Promise<CheckUpdatesResult> {
  try {
    const response = await fetch(
      `https://api.github.com/repos/${UPSTREAM_REPO}/releases/latest`,
      {
        headers: {
          'Accept': 'application/vnd.github.v3+json',
          'User-Agent': 'Ycode-Update-Checker',
        },
        cache: 'no-store',
      }
    );

    if (!response.ok) {
      return {
        available: false,
        currentVersion,
        message: 'Unable to check for updates',
      };
    }

    const release = await response.json();
    const latestVersion = release.tag_name?.replace(/^v/, '') || '1.0.0';

    const hasUpdate =
      latestVersion !== currentVersion &&
      compareVersions(latestVersion, currentVersion) > 0;

    // Detect deployment environment
    const isVercel = process.env.VERCEL === '1';
    const vercelGitProvider = process.env.VERCEL_GIT_PROVIDER;
    const vercelGitRepoOwner = process.env.VERCEL_GIT_REPO_OWNER;
    const vercelGitRepoSlug = process.env.VERCEL_GIT_REPO_SLUG;

    // Check if user's repo is a fork of the official repo
    let isFork = false;
    if (vercelGitProvider === 'github' && vercelGitRepoOwner && vercelGitRepoSlug) {
      try {
        const repoResponse = await fetch(
          `https://api.github.com/repos/${vercelGitRepoOwner}/${vercelGitRepoSlug}`,
          {
            headers: {
              'Accept': 'application/vnd.github.v3+json',
              'User-Agent': 'Ycode-Update-Checker',
            },
            cache: 'no-store',
          }
        );

        if (repoResponse.ok) {
          const repoData = await repoResponse.json();
          isFork =
            repoData.fork && repoData.parent?.full_name === UPSTREAM_REPO;
        }
      } catch (error) {
        console.error('Failed to check fork status:', error);
      }
    }

    // Determine update method
    let updateMethod: 'github-sync' | 'git-pull' | 'manual' = 'manual';
    let autoSyncUrl: string | undefined;
    let steps: string[] = [];

    if (
      isVercel &&
      vercelGitProvider === 'github' &&
      vercelGitRepoOwner &&
      vercelGitRepoSlug
    ) {
      updateMethod = 'github-sync';
      autoSyncUrl = `https://github.com/${vercelGitRepoOwner}/${vercelGitRepoSlug}/actions/workflows/sync-upstream.yml`;
      steps = [
        `Open the <a href="${autoSyncUrl}" target="_blank" class="underline font-semibold">MasjidWeb safe update workflow</a> in GitHub Actions`,
        'Click <strong class="text-white">"Run workflow"</strong> to create a safe Ycode update pull request',
        'Wait for GitHub checks to finish. If the PR is draft or says developer review is needed, do not merge it yet.',
        'Merge the pull request only after checks pass and the PR says it is safe to review',
        'Production deploys from main after the PR is merged. Reload the builder after deployment to apply the latest migrations.',
      ];
    } else {
      updateMethod = 'github-sync';
      autoSyncUrl = 'https://github.com/actions';
      steps = [
        'Use the MasjidWeb safe update workflow in GitHub Actions for this fork.',
        'Do not use GitHub Sync fork or manual direct merges into main.',
        'The workflow creates a pull request first, runs safety checks, and protects production until the PR is merged.',
      ];
    }

    return {
      available: hasUpdate,
      currentVersion,
      latestVersion,
      releaseUrl: release.html_url,
      releaseNotes: release.body,
      publishedAt: release.published_at,
      updateInstructions: {
        method: updateMethod,
        steps,
        autoSyncUrl,
      },
    };
  } catch (error) {
    console.error('Failed to check for updates:', error);
    return {
      available: false,
      currentVersion,
      error: 'Failed to check for updates',
    };
  }
}
