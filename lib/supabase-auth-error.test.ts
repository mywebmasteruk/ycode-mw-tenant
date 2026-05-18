import { describe, expect, it } from 'vitest';
import { isStaleSupabaseRefreshTokenError } from '@/lib/supabase-auth-error';

describe('isStaleSupabaseRefreshTokenError', () => {
  it('detects Supabase stale refresh token errors that can cause refresh loops', () => {
    expect(
      isStaleSupabaseRefreshTokenError(
        new Error('Invalid Refresh Token: Refresh Token Not Found'),
      ),
    ).toBe(true);
  });

  it('does not treat unrelated auth errors as stale refresh token loops', () => {
    expect(isStaleSupabaseRefreshTokenError(new Error('Invalid login credentials'))).toBe(false);
  });
});
