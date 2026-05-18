import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  createBrowserClient: vi.fn(),
}));

vi.mock('./supabase-browser', () => ({
  createBrowserClient: mocks.createBrowserClient,
}));

import { useAuthStore } from '../stores/useAuthStore';

describe('useAuthStore initialize', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useAuthStore.setState({
      user: null,
      session: null,
      loading: false,
      initialized: false,
      error: null,
    });
  });

  it('clears local auth state when Supabase reports a stale refresh token', async () => {
    const signOut = vi.fn().mockResolvedValue({ error: null });

    mocks.createBrowserClient.mockResolvedValue({
      auth: {
        getUser: vi.fn().mockRejectedValue(
          new Error('Invalid Refresh Token: Refresh Token Not Found'),
        ),
        getSession: vi.fn(),
        onAuthStateChange: vi.fn(),
        signOut,
      },
    });

    await useAuthStore.getState().initialize();

    expect(signOut).toHaveBeenCalledTimes(1);
    expect(useAuthStore.getState()).toMatchObject({
      user: null,
      session: null,
      initialized: true,
      error: null,
    });
  });
});
