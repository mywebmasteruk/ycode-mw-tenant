import { describe, expect, it } from 'vitest';
import {
  isStandaloneYcodeRoute,
  standaloneYcodeExactRoutes,
} from './ycode-standalone-routes';

describe('isStandaloneYcodeRoute', () => {
  it('treats accept-invite as standalone so auth hash is handled before shared client init', () => {
    expect(isStandaloneYcodeRoute('/ycode/accept-invite')).toBe(true);
    expect(standaloneYcodeExactRoutes).toContain('/ycode/accept-invite');
  });

  it('treats welcome as standalone', () => {
    expect(isStandaloneYcodeRoute('/ycode/welcome')).toBe(true);
  });

  it('treats preview and oauth prefixes as standalone', () => {
    expect(isStandaloneYcodeRoute('/ycode/preview/page')).toBe(true);
    expect(isStandaloneYcodeRoute('/ycode/oauth/callback')).toBe(true);
  });

  it('does not treat normal builder routes as standalone', () => {
    expect(isStandaloneYcodeRoute('/ycode')).toBe(false);
    expect(isStandaloneYcodeRoute('/ycode/pages/home')).toBe(false);
    expect(isStandaloneYcodeRoute('/ycode/settings/users')).toBe(false);
  });
});
