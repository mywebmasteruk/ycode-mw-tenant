import { NextRequest } from 'next/server';
import { createRouteClient } from '@/lib/supabase-route-client';
import { noCache } from '@/lib/api-response';

type SessionPostBody = {
  accessToken?: unknown;
  refreshToken?: unknown;
};

/**
 * GET /ycode/api/auth/session
 *
 * Get current user session
 */
export async function GET(request: NextRequest) {
  try {
    const supabase = await createRouteClient(request.headers);

    if (!supabase) {
      return noCache(
        { error: 'Supabase not configured' },
        500
      );
    }

    const { data: { session }, error } = await supabase.auth.getSession();

    if (error) {
      return noCache(
        { error: error.message },
        401
      );
    }

    return noCache({
      data: {
        session,
        user: session?.user || null,
      },
    });
  } catch (error) {
    console.error('Session check failed:', error);

    return noCache(
      { error: 'Session check failed' },
      500
    );
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json().catch(() => null)) as SessionPostBody | null;
    const accessToken = body?.accessToken;
    const refreshToken = body?.refreshToken;

    if (typeof accessToken !== 'string' || typeof refreshToken !== 'string') {
      return noCache({ error: 'Missing auth tokens' }, 400);
    }

    const supabase = await createRouteClient(request.headers);

    if (!supabase) {
      return noCache(
        { error: 'Supabase not configured' },
        500,
      );
    }

    const { data, error } = await supabase.auth.setSession({
      access_token: accessToken,
      refresh_token: refreshToken,
    });

    if (error || !data.session?.user) {
      return noCache(
        { error: error?.message || 'Session could not be saved' },
        401,
      );
    }

    return noCache({
      data: {
        user: data.session.user,
      },
    });
  } catch (error) {
    console.error('Session handoff failed:', error);

    return noCache(
      { error: 'Session handoff failed' },
      500,
    );
  }
}
