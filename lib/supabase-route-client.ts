import { createServerClient, type CookieOptions } from '@supabase/ssr';
import { cookies } from 'next/headers';
import { credentials } from './credentials';
import { supabaseCookieOptionsForRequestHeaders } from '@/lib/supabase-cookie-domain';
import { parseSupabaseConfig } from './supabase-config-parser';
import type { SupabaseConfig } from '@/types';
import { supabaseServerRealtimeOptions } from '@/lib/supabase-server-options';

/**
 * Create a Supabase server client for use in Next.js route handlers.
 *
 * Reads stored credentials, parses the config, and wires up cookie
 * get/set/remove so auth sessions work correctly in API routes.
 *
 * Returns null if Supabase is not configured (expected during setup).
 */
export async function createRouteClient(requestHeaders?: Headers) {
  const config = await credentials.get<SupabaseConfig>('supabase_config');
  if (!config) return null;

  const parsed = parseSupabaseConfig(config);
  const cookieStore = await cookies();
  const cookieOpts = requestHeaders
    ? supabaseCookieOptionsForRequestHeaders(
      requestHeaders,
      undefined,
      parsed.projectUrl,
    )
    : null;

  return createServerClient(parsed.projectUrl, parsed.anonKey, {
    cookies: {
      get(name: string) {
        return cookieStore.get(name)?.value;
      },
      set(name: string, value: string, options: CookieOptions) {
        cookieStore.set({ name, value, ...options });
      },
      remove(name: string, options: CookieOptions) {
        cookieStore.set({ name, value: '', ...options });
      },
    },
    realtime: supabaseServerRealtimeOptions,
    ...(cookieOpts ? { cookieOptions: cookieOpts } : {}),
  });
}
