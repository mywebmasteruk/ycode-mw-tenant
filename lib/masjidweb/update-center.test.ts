import { describe, expect, it } from 'vitest';
import { mapAdminUpdateStatus } from './update-center';

describe('mapAdminUpdateStatus', () => {
  it('shows setup required when GitHub update configuration is missing', () => {
    const status = mapAdminUpdateStatus({
      configured: false,
      updateAvailable: true,
      currentVersion: '1.6.1',
      latestVersion: '1.8.0',
    });

    expect(status.status).toBe('setup_required');
    expect(status.title).toBe('Setup needed before updates can be prepared');
    expect(status.canPrepare).toBe(false);
    expect(status.productionProtected).toBe(true);
  });

  it('shows a safe prepare button when an update is available and no PR exists yet', () => {
    const status = mapAdminUpdateStatus({
      configured: true,
      updateAvailable: true,
      currentVersion: '1.6.1',
      latestVersion: '1.8.0',
    });

    expect(status.status).toBe('update_available');
    expect(status.title).toBe('A new core update is available');
    expect(status.canPrepare).toBe(true);
    expect(status.primaryActionLabel).toBe('Prepare safe update');
  });

  it('asks for safety review when the update PR is draft or tenant-sensitive', () => {
    const status = mapAdminUpdateStatus({
      configured: true,
      updateAvailable: true,
      currentVersion: '1.6.1',
      latestVersion: '1.8.0',
      pullRequest: {
        number: 12,
        url: 'https://github.com/mywebmasteruk/ycode-mw-tenant/pull/12',
        title: 'chore: review Ycode core update to v1.8.0',
        draft: true,
        labels: ['safe-ycode-update', 'needs-developer-review', 'tenant-sensitive-update'],
        mergeable: false,
        checksStatus: 'pending',
      },
    });

    expect(status.status).toBe('needs_safety_review');
    expect(status.title).toBe('This update needs safety review');
    expect(status.canPrepare).toBe(false);
    expect(status.reviewUrl).toContain('/pull/12');
  });

  it('blocks automatic progress when the update PR has conflicts', () => {
    const status = mapAdminUpdateStatus({
      configured: true,
      updateAvailable: true,
      currentVersion: '1.6.1',
      latestVersion: '1.8.0',
      pullRequest: {
        number: 13,
        url: 'https://github.com/mywebmasteruk/ycode-mw-tenant/pull/13',
        title: 'chore: review Ycode core update to v1.8.0',
        draft: true,
        labels: ['safe-ycode-update', 'needs-developer-review'],
        mergeable: false,
        checksStatus: 'pending',
        hasConflicts: true,
      },
    });

    expect(status.status).toBe('blocked');
    expect(status.title).toBe('This update is blocked');
    expect(status.description).toContain('conflicts');
  });

  it('shows safe to review only after checks pass on a non-draft PR', () => {
    const status = mapAdminUpdateStatus({
      configured: true,
      updateAvailable: true,
      currentVersion: '1.6.1',
      latestVersion: '1.8.0',
      pullRequest: {
        number: 14,
        url: 'https://github.com/mywebmasteruk/ycode-mw-tenant/pull/14',
        title: 'chore: update Ycode core to v1.8.0',
        draft: false,
        labels: ['safe-ycode-update'],
        mergeable: true,
        checksStatus: 'success',
      },
    });

    expect(status.status).toBe('safe_to_review');
    expect(status.title).toBe('Update prepared and checks passed');
    expect(status.canPrepare).toBe(false);
  });
});
