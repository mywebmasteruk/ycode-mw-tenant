import { createServerClient, type CookieOptions } from '@supabase/ssr';
import { NextRequest, NextResponse } from 'next/server';
import { createRouteClient } from '@/lib/supabase-route-client';
import { noCache } from '@/lib/api-response';
import { credentials } from '@/lib/credentials';
import { parseSupabaseConfig } from '@/lib/supabase-config-parser';
import { supabaseCookieOptionsForRequestHeaders } from '@/lib/supabase-cookie-domain';
import type { SupabaseConfig } from '@/types';

type SessionPostBody = {
  accessToken?: unknown;
  refreshToken?: unknown;
};

type CookieToSet = {
  name: string;
  value: string;
  options: CookieOptions;
};

function authJson<T>(data: T, status = 200): NextResponse<T> {
  return NextResponse.json(data, {
    status,
    headers: {
      'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0',
      Pragma: 'no-cache',
      Expires: '0',
      'CDN-Cache-Control': 'no-store',
      'Vercel-CDN-Cache-Control': 'no-store',
      'Surrogate-Control': 'no-store',
    },
  });
}

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
  const pendingCookies: CookieToSet[] = [];

  try {
    const body = (await request.json().catch(() => null)) as SessionPostBody | null;
    const accessToken = body?.accessToken;
    const refreshToken = body?.refreshToken;

    if (typeof accessToken !== 'string' || typeof refreshToken !== 'string') {
      return authJson({ error: 'Missing auth tokens' }, 400);
    }

    const config = await credentials.get<SupabaseConfig>('supabase_config');

    if (!config) {
      return authJson(
        { error: 'Supabase not configured' },
        500,
      );
    }

    const parsed = parseSupabaseConfig(config);
    const cookieOpts = supabaseCookieOptionsForRequestHeaders(request.headers);

    const supabase = createServerClient(parsed.projectUrl, parsed.anonKey, {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          pendingCookies.push(...cookiesToSet);
        },
      },
      ...(cookieOpts ? { cookieOptions: cookieOpts } : {}),
    });

    const { data, error } = await supabase.auth.setSession({
      access_token: accessToken,
      refresh_token: refreshToken,
    });

    if (error || !data.session?.user) {
      return authJson(
        { error: error?.message || 'Session could not be saved' },
        401,
      );
    }

    const response = authJson({
      data: {
        user: data.session.user,
      },
    });

    pendingCookies.forEach(({ name, value, options }) => {
      response.cookies.set(name, value, options);
    });

    return response;
  } catch (error) {
    console.error('Session handoff failed:', error);

    return authJson(
      { error: 'Session handoff failed' },
      500,
    );
  }
}
