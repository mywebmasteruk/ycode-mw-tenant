/**
 * MASJIDWEB internal route — cacheable slug-page variant. See proxy.ts and
 * lib/masjidweb/route-tenant-resolution.ts.
 *
 * Reached ONLY via proxy.ts's internal rewrite of `tenant.<suffix>/<slug>` when
 * MW_ROUTE_TENANT_RESOLUTION is enabled for the host. Direct external access to
 * `/mw-tenant/*` is 404'd by the proxy guard, so `tenantId` here is always the
 * proxy-resolved, trusted tenant id.
 *
 * Tenant comes from the `[tenantId]` route param (not `headers()`), injected
 * via runWithEffectiveTenantId; the reused Page render then sees only its own
 * `[...slug]` param and resolves the right tenant. On the non-password-protected
 * path it calls no Dynamic API, so the page is ISR-cacheable keyed per
 * (tenant, slug) by the path — the tenant dimension is in the cache key, so
 * two tenants sharing a slug can never collide.
 *
 * The render is the exact Page implementation from app/(site)/[...slug]/page.tsx.
 * We deliberately do NOT re-export its generateStaticParams (which enumerates a
 * single build-time tenant) — these routes generate on demand per requested
 * (tenantId, slug), so no tenant's content is ever baked into a slug-only
 * artifact.
 */
import type { Metadata } from 'next';
import Page, { generateMetadata as slugGenerateMetadata } from '../../../(site)/[...slug]/page';
import {
  runWithEffectiveTenantId,
  setRequestEffectiveTenantId,
} from '@/lib/masjidweb/effective-tenant-id';

export const dynamicParams = true;
export const revalidate = false;

/**
 * Deliberately returns [] — nothing is baked at build time (unlike the (site)
 * [...slug] route's generateStaticParams, which enumerates a single build-time
 * tenant — the cross-tenant-bake risk this tree exists to avoid), but
 * declaring this is what registers the route as ISR-capable: without
 * generateStaticParams, Next classifies a dynamic-param route as fully
 * dynamic and never caches it (verified via .next/prerender-manifest.json).
 * Every (tenantId, slug) path is generated on first request and cached until
 * the publish-tag purge.
 */
export function generateStaticParams(): Array<{ tenantId: string; slug: string[] }> {
  return [];
}

interface Props {
  params: Promise<{ tenantId: string; slug: string | string[] }>;
}

export default async function TenantSlugPage({ params }: Props) {
  const { tenantId, slug } = await params;
  setRequestEffectiveTenantId(tenantId);
  return runWithEffectiveTenantId(tenantId, () =>
    Page({ params: Promise.resolve({ slug }) }),
  );
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { tenantId, slug } = await params;
  setRequestEffectiveTenantId(tenantId);
  return runWithEffectiveTenantId(tenantId, () =>
    slugGenerateMetadata({ params: Promise.resolve({ slug }) }),
  );
}
