import 'server-only';

import type { SupabaseConfig } from '@/types';
import { credentials } from '@/lib/credentials';
import { parseSupabaseConfig } from '@/lib/supabase-config-parser';

/**
 * URL + anon key for SSR auth (callback, cookies). Prefer full wizard config;
 * fall back to env when Netlify sets only public Supabase vars.
 */
export async function getSupabasePublicClientConfig(): Promise<{
  url: string;
  anonKey: string;
} | null> {
  const raw = await credentials.get<SupabaseConfig>('supabase_config');
  if (raw) {
    try {
      const parsed = parseSupabaseConfig(raw);
      return { url: parsed.projectUrl, anonKey: parsed.anonKey };
    } catch (e) {
      console.error('[supabase] parseSupabaseConfig failed:', e);
    }
  }

  const url =
    process.env.NEXT_PUBLIC_SUPABASE_URL?.trim() ||
    process.env.SUPABASE_URL?.trim();
  const anonKey =
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY?.trim() ||
    process.env.SUPABASE_PUBLISHABLE_KEY?.trim() ||
    process.env.SUPABASE_ANON_KEY?.trim();

  if (url && anonKey) {
    return { url, anonKey };
  }

  return null;
}
