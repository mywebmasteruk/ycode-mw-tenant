import { describe, expect, it } from 'vitest';
import { isSessionInvalidError } from './session-error';

describe('isSessionInvalidError', () => {
  it('treats tenant mismatch as an invalid session', () => {
    expect(isSessionInvalidError('Tenant mismatch between session and site')).toBe(true);
  });

  it('treats missing authentication as an invalid session', () => {
    expect(isSessionInvalidError('Not authenticated')).toBe(true);
  });

  it('does not treat unrelated API errors as invalid sessions', () => {
    expect(isSessionInvalidError('Failed to load editor data')).toBe(false);
    expect(isSessionInvalidError(undefined)).toBe(false);
  });
});
