import Link from 'next/link';
import { unstable_cache } from 'next/cache';
import { fetchErrorPage, slimPageData } from '@/lib/page-fetcher';
import { fetchGlobalPageSettings } from '@/lib/generate-page-metadata';
import { getSettingByKey } from '@/lib/repositories/settingsRepository';
import { tenantStore } from '@/lib/supabase-server';
import { resolveEffectiveTenantId, runWithEffectiveTenantIdIfPresent } from '@/lib/masjidweb/effective-tenant-id';
import { tenantAllPagesTag } from '@/lib/masjidweb/tenant-cache-tags';
import PageRenderer from '@/components/PageRenderer';
import YcodeBadge from '@/components/YcodeBadge';

/** Cached lookup of the user's custom 404 page, invalidated on publish. */
// MASJIDWEB_SEAM: tenant-scoped 404 cache — the key was a FIXED ['error-404']
// with the raw 'all-pages' tag: one shared cache entry for every tenant, so
// the first tenant to 404 baked THEIR custom 404 page into the entry served
// to all other tenants' 404s (and the raw tag is never revalidated by the
// tenant-scoped publish purge, so it also never invalidated). Same bug class
// as PageRenderer's page/folder caches — key + tag now carry the tenant and
// the callback re-establishes tenant context.
function fetchCachedCustom404(tenantId?: string) {
  return unstable_cache(
    async () => runWithEffectiveTenantIdIfPresent(tenantId, async () => {
      const data = await fetchErrorPage(404, true, tenantId);
      return data ? slimPageData(data) : null;
    }),
    ['error-404', tenantId ?? '_'],
    { tags: [tenantAllPagesTag(tenantId ?? null)], revalidate: false }
  )();
}
// MASJIDWEB_SEAM_END

/**
 * 404 boundary for public pages. Renders the user's custom 404 page when one
 * exists, otherwise a default fallback. Next.js serves this with a real HTTP
 * 404 status, which avoids soft-404 SEO penalties from search engines.
 */
export default async function NotFound() {
  // MASJIDWEB_SEAM: not-found boundaries receive no params — resolve tenant
  // from the explicit webhook-style store first, then the standard resolver
  // (headers on the header path, the render-pass pin on the param-based path).
  const tenantId = tenantStore.getStore() ?? (await resolveEffectiveTenantId()) ?? undefined;
  // MASJIDWEB_SEAM_END

  const errorPageData = await fetchCachedCustom404(tenantId).catch(() => null);

  if (errorPageData) {
    const globalSettings = await fetchGlobalPageSettings().catch(() => null);
    const { page, pageLayers, components } = errorPageData;

    return (
      <PageRenderer
        page={page}
        layers={pageLayers.layers || []}
        components={components}
        generatedCss={globalSettings?.publishedCss || undefined}
        colorVariablesCss={globalSettings?.colorVariablesCss || undefined}
        globalCustomCodeHead={globalSettings?.globalCustomCodeHead}
        globalCustomCodeBody={globalSettings?.globalCustomCodeBody}
        ycodeBadge={globalSettings?.ycodeBadge ?? true}
      />
    );
  }

  let showBadge = true;
  try {
    const setting = await getSettingByKey('ycode_badge');
    showBadge = setting ?? true;
  } catch {
    // Supabase not configured
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-white">
      <div className="text-center max-w-md px-4">
        <h1 className="text-6xl font-bold text-gray-900 mb-4">404</h1>
        <h2 className="text-2xl font-semibold text-gray-800 mb-4">Page Not Found</h2>
        <p className="text-gray-600 mb-8">
          The page you&apos;re looking for doesn&apos;t exist or has been moved.
        </p>
        <Link
          href="/"
          className="inline-block px-6 py-3 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors"
        >
          Go Home
        </Link>
      </div>
      {showBadge && <YcodeBadge />}
    </div>
  );
}
