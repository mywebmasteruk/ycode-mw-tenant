import { afterEach, describe, expect, it, vi } from 'vitest';
import { overlayTestHostname } from '@/lib/masjidweb/overlay-test-host';

describe('overlayTestHostname', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('is inert when overlay fail-closed is off (production)', () => {
    vi.stubEnv('MW_OVERLAY_FAIL_CLOSED', '');
    vi.stubEnv('MW_OVERLAY_TEST_SECRET', 's');
    const headers = new Headers({
      'x-mw-overlay-test-secret': 's',
      'x-mw-overlay-test-host': 'high900.masjidweb.com',
    });
    expect(overlayTestHostname(headers)).toBeNull();
  });

  it('rejects a missing or wrong secret', () => {
    vi.stubEnv('MW_OVERLAY_FAIL_CLOSED', 'true');
    vi.stubEnv('MW_OVERLAY_TEST_SECRET', 'expected');
    expect(
      overlayTestHostname(
        new Headers({
          'x-mw-overlay-test-secret': 'wrong',
          'x-mw-overlay-test-host': 'high900.masjidweb.com',
        }),
      ),
    ).toBeNull();
  });

  it('returns the tenant host when overlay is on and the secret matches', () => {
    vi.stubEnv('MW_OVERLAY_FAIL_CLOSED', 'true');
    vi.stubEnv('MW_OVERLAY_TEST_SECRET', 'expected');
    expect(
      overlayTestHostname(
        new Headers({
          'x-mw-overlay-test-secret': 'expected',
          'x-mw-overlay-test-host': 'High900.masjidweb.com:443',
        }),
      ),
    ).toBe('high900.masjidweb.com');
  });
});
