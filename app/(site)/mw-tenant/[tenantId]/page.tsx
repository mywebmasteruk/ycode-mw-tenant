/**
 * MASJIDWEB internal route — cacheable homepage variant. See proxy.ts and
 * lib/masjidweb/route-tenant-resolution.ts.
 *
 * Reached ONLY via proxy.ts's internal rewrite of `tenant.<suffix>/` when
 * MW_ROUTE_TENANT_RESOLUTION is enabled for the host. Direct external access
 * to `/mw-tenant/*` is 404'd by the proxy guard, so `tenantId` here is always
 * the proxy-resolved, trusted tenant id.
 *
 * Tenant comes from the `[tenantId]` route param (not `headers()`), injected
 * via runWithEffectiveTenantId so the reused Home render resolves the right
 * tenant while calling no Dynamic API on the non-password-protected path —
 * making the page ISR-cacheable, keyed per tenant by the path. The actual
 * render is the exact Home implementation from app/(site)/page.tsx: one source
 * of truth, no duplication.
 */
import type { Metadata } from 'next';
import Home, { generateMetadata as homeGenerateMetadata } from '../../page';
import { runWithEffectiveTenantId } from '@/lib/masjidweb/effective-tenant-id';

export const dynamicParams = true;
export const revalidate = false;

interface Props {
  params: Promise<{ tenantId: string }>;
}

export default async function TenantHome({ params }: Props) {
  const { tenantId } = await params;
  return runWithEffectiveTenantId(tenantId, () => Home());
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { tenantId } = await params;
  return runWithEffectiveTenantId(tenantId, () => homeGenerateMetadata());
}
