import { createServerClient, type CookieOptions } from '@supabase/ssr';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { NextRequest } from 'next/server';
import { cookies, headers } from 'next/headers';
import { getSupabaseEnvConfig } from '@/lib/tenant';
import { supabaseCookieOptionsForRequestHeaders } from '@/lib/supabase-cookie-domain';

/**
 * Supabase client using the **anon key + user session** (RLS applies for `authenticated`).
 *
 * Repositories today use `getSupabaseAdmin()` (service role), which **bypasses** RLS. Use this
 * client when migrating builder CRUD so Postgres policies in
 * `supabase/migrations/*tenant_rls*.sql` enforce `tenant_id` without relying on every `.eq()`.
 *
 * - **`createBuilderSupabaseReadOnly`**: safe for proxy-style reads (`setAll` no-op).
 * - **`createBuilderSupabaseFromServerCookies`**: full cookie read/write for Server Components / Actions
 *   (call only from contexts where `cookies()` can set response cookies).
 */

export function createBuilderSupabaseReadOnly(
  request: NextRequest,
): SupabaseClient | null {
  const config = getSupabaseEnvConfig();
  if (!config) return null;

  const cookieOpts = supabaseCookieOptionsForRequestHeaders(
    request.headers,
    undefined,
    config.url,
  );

  return createServerClient(config.url, config.anonKey, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll() {
        /* read-only: no session refresh persistence */
      },
    },
    ...(cookieOpts ? { cookieOptions: cookieOpts } : {}),
  });
}

export async function createBuilderSupabaseFromServerCookies(): Promise<SupabaseClient | null> {
  const config = getSupabaseEnvConfig();
  if (!config) return null;

  const cookieStore = await cookies();
  const h = await headers();
  const cookieOpts = supabaseCookieOptionsForRequestHeaders(
    h,
    undefined,
    config.url,
  );

  return createServerClient(config.url, config.anonKey, {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet: { name: string; value: string; options: CookieOptions }[]) {
        try {
          cookiesToSet.forEach(({ name, value, options }) => {
            cookieStore.set(name, value, options);
          });
        } catch {
          /* called from a static context — ignore */
        }
      },
    },
    ...(cookieOpts ? { cookieOptions: cookieOpts } : {}),
  });
}
