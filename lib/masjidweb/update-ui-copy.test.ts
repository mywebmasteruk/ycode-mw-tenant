import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();

function readWorkspaceFile(path: string) {
  return readFileSync(join(root, path), 'utf8');
}

describe('MasjidWeb update UI copy', () => {
  it('does not show old Sync Fork wording in update UI surfaces', () => {
    const updateSettings = readWorkspaceFile('app/(builder)/ycode/settings/updates/UpdatesSettingsClient.tsx');
    const updateNotification = readWorkspaceFile('components/UpdateNotification.tsx');

    expect(updateSettings).not.toContain('Sync Fork');
    expect(updateNotification).not.toContain('Sync Fork');
  });

  it('points admins to the update center instead of GitHub workflow instructions', () => {
    const updateNotification = readWorkspaceFile('components/UpdateNotification.tsx');

    expect(updateNotification).toContain('Open update center');
    expect(updateNotification).toContain('/ycode/settings/updates');
  });
});
