// MASJIDWEB: additive route (not part of Ycode core — no upstream merge surface).
//
// RLS mint health for the seam-retirement experiment (MW_SEAMS_RETIRED): actively
// proves the tenant-JWT mint path end-to-end (key loads → signing works → PostgREST
// trusts the token via JWKS) and reports service-role fallback telemetry. With the
// seams retired, a silently broken mint would mean queries silently fall back to
// service_role with the app-layer filter re-armed — safe, but worth alerting on.
// Returns booleans/counters only; kid is public via JWKS; no secrets.
import { NextResponse } from 'next/server';
import { getSupabaseConfig } from '@/lib/supabase-server';
import {
  getTenantRlsTelemetry,
  probeTenantRlsMint,
  tenantRlsEnforceEnabled,
  type TenantRlsMintProbe,
} from '@/lib/masjidweb/tenant-rls-client';
import { seamRetirementEnabled } from '@/lib/masjidweb/apply-tenant-eq';

export const revalidate = 0;

export async function GET() {
  const creds = await getSupabaseConfig();
  const probe: TenantRlsMintProbe = creds
    ? await probeTenantRlsMint(creds.projectUrl, creds.anonKey)
    : {
        enforce: tenantRlsEnforceEnabled(),
        keyLoaded: false,
        signOk: false,
        kid: null,
        jwksTrusted: null,
      };

  // Healthy = enforcement off (nothing to prove), or the full mint path works and
  // PostgREST did not EXPLICITLY reject the token (null = network-inconclusive).
  const healthy = !probe.enforce || (probe.keyLoaded && probe.signOk && probe.jwksTrusted !== false);

  return NextResponse.json(
    {
      healthy,
      seamsRetired: seamRetirementEnabled(),
      ...probe,
      telemetry: getTenantRlsTelemetry(),
    },
    { status: healthy ? 200 : 503 },
  );
}
