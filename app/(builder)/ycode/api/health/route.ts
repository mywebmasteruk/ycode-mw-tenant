import { NextResponse } from 'next/server';
import { getSupabaseAdmin } from '@/lib/supabase-server';

export const revalidate = 0;

export async function GET() {
  const checks: Record<string, { ok: boolean; ms?: number; error?: string }> = {};

  const supaStart = Date.now();
  try {
    const sb = await getSupabaseAdmin();
    if (sb) {
      // DB connectivity probe — returns no row data to the caller (only ok/ms).
      // isolation-ok: not tenant-relevant; selects one arbitrary column to ping
      const { error } = await sb.from('settings').select('key').limit(1);
      checks.supabase = error
        ? { ok: false, ms: Date.now() - supaStart, error: error.message }
        : { ok: true, ms: Date.now() - supaStart };
    } else {
      checks.supabase = { ok: false, error: 'no credentials configured' };
    }
  } catch (e) {
    checks.supabase = {
      ok: false,
      ms: Date.now() - supaStart,
      error: e instanceof Error ? e.message : String(e),
    };
  }

  const requiredEnvVars = [
    'NEXT_PUBLIC_SUPABASE_URL',
    'TENANT_DOMAIN_SUFFIX',
  ];
  const missingEnv = requiredEnvVars.filter((k) => !process.env[k]?.trim());
  checks.env = missingEnv.length
    ? { ok: false, error: `missing: ${missingEnv.join(', ')}` }
    : { ok: true };

  const allOk = Object.values(checks).every((c) => c.ok);

  return NextResponse.json(
    { status: allOk ? 'healthy' : 'degraded', checks },
    { status: allOk ? 200 : 503 },
  );
}
