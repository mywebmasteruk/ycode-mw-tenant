/**
 * Server-side auth utilities for API routes.
 * Creates a Supabase client from cookies and verifies the session.
 */

import { createServerClient, type CookieOptions } from '@supabase/ssr';
import { cookies, headers } from 'next/headers';
import { supabaseCookieOptionsForRequestHeaders } from '@/lib/supabase-cookie-domain';
import { credentials } from '@/lib/credentials';
import { parseSupabaseConfig } from '@/lib/supabase-config-parser';
import type { SupabaseClient, User } from '@supabase/supabase-js';
import type { SupabaseConfig } from '@/types';
import { supabaseServerRealtimeOptions } from '@/lib/supabase-server-options';

interface AuthResult {
  user: User;
  client: SupabaseClient;
}

type CookieToSet = {
  name: string;
  value: string;
  options: CookieOptions;
};

/**
 * Get the authenticated user and Supabase client from request cookies.
 * Returns null if not authenticated or Supabase is not configured.
 */
export async function getAuthUser(): Promise<AuthResult | null> {
  try {
    const config = await credentials.get<SupabaseConfig>('supabase_config');
    if (!config) return null;

    const parsed = parseSupabaseConfig(config);
    const cookieStore = await cookies();
    const h = await headers();
    const cookieOpts = supabaseCookieOptionsForRequestHeaders(h);

    const client = createServerClient(parsed.projectUrl, parsed.anonKey, {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet: CookieToSet[]) {
          cookiesToSet.forEach(({ name, value, options }) => {
            cookieStore.set({ name, value, ...options });
          });
        },
      },
      realtime: supabaseServerRealtimeOptions,
      ...(cookieOpts ? { cookieOptions: cookieOpts } : {}),
    });

    const { data: { user }, error } = await client.auth.getUser();
    if (error || !user) return null;

    return { user, client };
  } catch {
    return null;
  }
}
