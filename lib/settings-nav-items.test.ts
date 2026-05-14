import { describe, expect, it } from 'vitest';
import { getSettingsNavItemsForTenant } from './settings-nav-items';

describe('getSettingsNavItemsForTenant', () => {
  it('includes Updates for template tenants', () => {
    const itemIds = getSettingsNavItemsForTenant(true).map((item) => item.id);

    expect(itemIds).toContain('updates');
  });

  it('hides Updates for non-template tenants', () => {
    const itemIds = getSettingsNavItemsForTenant(false).map((item) => item.id);

    expect(itemIds).not.toContain('updates');
    expect(itemIds).toContain('general');
  });
});
