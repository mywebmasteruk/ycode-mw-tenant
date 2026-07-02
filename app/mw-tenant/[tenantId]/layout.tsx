/**
 * MASJIDWEB internal route — root layout for the cacheable tenant routes. See
 * proxy.ts and lib/masjidweb/route-tenant-resolution.ts.
 *
 * This tree deliberately lives OUTSIDE the (site) route group: the (site)
 * layout's generateMetadata()/body call fetchGlobalPageSettings() ->
 * resolveEffectiveTenantId() -> headers() with no tenant override in scope,
 * and that single headers() read forces every route under it dynamic —
 * verified live on the canary (the rewrite fired, but responses stayed
 * uncached until the tree was moved out from under that layout). Layouts
 * above the [tenantId] segment can't receive the tenantId param, so the
 * override can't be injected into the (site) layout from here; instead this
 * layout IS the tree's root layout and wraps the exact same (site) layout
 * implementation in runWithEffectiveTenantId — one source of truth, with the
 * tenant resolved from the route param instead of headers().
 */
import type { Metadata } from 'next';
import SiteLayout, { generateMetadata as siteGenerateMetadata } from '../../(site)/layout';
import { runWithEffectiveTenantId } from '@/lib/masjidweb/effective-tenant-id';

interface Props {
  children: React.ReactNode;
  params: Promise<{ tenantId: string }>;
}

export default async function TenantSiteLayout({ children, params }: Props) {
  const { tenantId } = await params;
  return runWithEffectiveTenantId(tenantId, () => SiteLayout({ children }));
}

export async function generateMetadata({ params }: Pick<Props, 'params'>): Promise<Metadata> {
  const { tenantId } = await params;
  return runWithEffectiveTenantId(tenantId, () => siteGenerateMetadata());
}
