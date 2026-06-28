import { notFound, redirect, permanentRedirect } from 'next/navigation';
import { connection } from 'next/server';
import { unstable_cache } from 'next/cache';
import { addCacheTag } from '@vercel/functions';
import type { Metadata } from 'next';
import { cache } from 'react';
import { getSupabaseAdmin } from '@/lib/supabase-server';
import { buildSlugPath } from '@/lib/page-utils';
import { generatePageMetadata, fetchGlobalPageSettings } from '@/lib/generate-page-metadata';
import { fetchPageByPath, fetchPageByPathForMetadata, fetchErrorPage, splitPageData, reassemblePageData, slimPageData } from '@/lib/page-fetcher';
import PageRenderer from '@/components/PageRenderer';
import PasswordForm from '@/components/PasswordForm';
import { getSettingByKey } from '@/lib/repositories/settingsRepository';
import { parseAuthCookie, getPasswordProtection, fetchFoldersForAuth } from '@/lib/page-auth';
import { resolveEffectiveTenantId } from '@/lib/masjidweb/effective-tenant-id';
import { settingsTenantIdOrNull } from '@/lib/masjidweb/settings-tenant-id';
import { applyTenantEq } from '@/lib/masjidweb/apply-tenant-eq';
import {
  tenantAllPagesTag,
  tenantRouteTag,
} from '@/lib/masjidweb/tenant-cache-tags';
import { getSiteBaseUrl } from '@/lib/url-utils';
import { matchRedirect } from '@/lib/redirect-utils';
import type { Page, PageFolder, Translation, Redirect as RedirectType } from '@/types';

// Avoid ISR full-route caching on Netlify (stale HTML after publish).
export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const dynamicParams = true;

const getTenantCacheContext = cache(async () => {
  const effectiveTid = await resolveEffectiveTenantId();
  let publishedAtVersion = '_';
  try {
    const publishedAt = await getSettingByKey('published_at');
    if (typeof publishedAt === 'string' && publishedAt.trim()) {
      publishedAtVersion = publishedAt.trim();
    } else if (publishedAt != null) {
      publishedAtVersion = JSON.stringify(publishedAt);
    }
  } catch {
    // Non-fatal: keep a stable fallback suffix.
  }
  return {
    effectiveTid,
    keySuffix: `${effectiveTid ?? '_'}:${publishedAtVersion}`,
  };
});

/**
 * Generate static params for known published pages
 * This tells Next.js which pages to pre-render
 * Includes both default locale paths and translated paths for all locales
 */
export async function generateStaticParams() {
  const effectiveTenantId = await resolveEffectiveTenantId();
  try {
    const supabase = await getSupabaseAdmin();

    if (!supabase) {
      return [];
    }

    const tenantId = settingsTenantIdOrNull();
    if (!tenantId) {
      return [];
    }

    let pagesQuery = supabase
      .from('pages')
      .select('*')
      .eq('is_published', true)
      .is('deleted_at', null);
    pagesQuery = applyTenantEq(pagesQuery, tenantId);
    const { data: pages } = await pagesQuery;

    let foldersQuery = supabase
      .from('page_folders')
      .select('*')
      .eq('is_published', true)
      .is('deleted_at', null);
    foldersQuery = applyTenantEq(foldersQuery, tenantId);
    const { data: folders } = await foldersQuery;

    let localesQuery = supabase
      .from('locales')
      .select('*')
      .is('deleted_at', null);
    localesQuery = applyTenantEq(localesQuery, tenantId);
    const { data: locales } = await localesQuery;

    const localeIds = (locales ?? []).map((l) => l.id);
    const { data: translations } =
      localeIds.length > 0
        ? await applyTenantEq(supabase
          .from('translations')
          .select('*')
          .eq('is_published', true)
          .is('deleted_at', null)
          .in('locale_id', localeIds), effectiveTenantId)
        : { data: null };

    if (!pages || !folders) {
      return [];
    }

    const params: { slug: string[] }[] = [];

    // Build translations map for easier lookup
    const translationsMap: Record<string, Record<string, Translation>> = {};
    if (translations) {
      for (const translation of translations) {
        if (!translationsMap[translation.locale_id]) {
          translationsMap[translation.locale_id] = {};
        }
        const key = `${translation.source_type}:${translation.source_id}:${translation.content_key}`;
        translationsMap[translation.locale_id][key] = translation;
      }
    }

    // Generate localized homepage paths (e.g., /fr/, /es/)
    if (locales) {
      for (const locale of locales) {
        if (locale.is_default) continue; // Skip default locale (/ is handled by app/page.tsx)
        params.push({ slug: [locale.code] });
      }
    }

    // Generate params for each non-dynamic page
    for (const page of pages) {
      // Skip dynamic pages - they are handled dynamically at request time
      if (page.is_dynamic) {
        continue;
      }

      // Generate default locale path (no locale prefix)
      const defaultPath = buildSlugPath(page, folders as PageFolder[], 'page');
      const defaultSegments = defaultPath.slice(1).split('/').filter(Boolean);

      // Skip empty paths (homepage is handled by app/page.tsx)
      if (defaultSegments.length > 0) {
        params.push({ slug: defaultSegments });
      }

      // Generate translated paths for non-default locales
      if (locales) {
        for (const locale of locales) {
          if (locale.is_default) continue; // Skip default locale

          const localeTranslations = translationsMap[locale.id] || {};

          // Build localized path with translated slugs
          const slugParts: string[] = [locale.code];

          // Add translated folder path
          let currentFolderId = page.page_folder_id;
          const folderSegments: string[] = [];
          while (currentFolderId) {
            const folder = folders.find(f => f.id === currentFolderId);
            if (!folder) break;

            const translationKey = `folder:${folder.id}:slug`;
            const translatedSlug = localeTranslations[translationKey]?.content_value || folder.slug;
            folderSegments.unshift(translatedSlug);

            currentFolderId = folder.page_folder_id;
          }
          slugParts.push(...folderSegments);

          // Add page's own slug
          if (!page.is_index && page.slug) {
            const pageKey = `page:${page.id}:slug`;
            const translatedSlug = localeTranslations[pageKey]?.content_value || page.slug;
            slugParts.push(translatedSlug);
          }

          const localizedSegments = slugParts.filter(Boolean);
          if (localizedSegments.length > 1) { // Must have at least locale + something
            params.push({ slug: localizedSegments });
          }
        }
      }
    }

    return params;
  } catch (error) {
    console.error('Failed to generate static params:', error);
    return [];
  }
}

/**
 * Fetch published page and layers data from database
 * Cached per slug and page for revalidation
 */
async function fetchPublishedPageWithLayers(slugPath: string) {
  const { effectiveTid, keySuffix } = await getTenantCacheContext();
  // MASJIDWEB_SEAM: tenant-scoped cache tags — see docs/masjidweb-core-seams.md#tier-4
  // Tags are both 'route-/X' AND 'all-pages':
  // - route-/X lets selective invalidation purge just this page's data cache
  // - all-pages lets full invalidation (color variables, redirects, etc.)
  //   sweep every page's data cache in one invalidateByTag call.
  // Vercel's invalidateByTag is tag-precise — invalidating one route's tag
  // doesn't cascade to entries that only share 'all-pages'. (Next.js bug
  // #63509 would apply if we used revalidateTag for selective, but we route
  // exclusively through invalidateByTag on Vercel.)
  const tags = [
    tenantAllPagesTag(effectiveTid),
    tenantRouteTag(effectiveTid, slugPath),
  ];
  // MASJIDWEB_SEAM_END
  const opts = { tags, revalidate: false as const };

  try {
    const [core, layers] = await Promise.all([
      unstable_cache(
        async () => {
          const data = await fetchPageByPath(slugPath, true);
          if (!data) return null;
          return splitPageData(data).core;
        },
        [`core-/${slugPath}`, keySuffix],
        opts
      )(),
      unstable_cache(
        async () => {
          const data = await fetchPageByPath(slugPath, true);
          if (!data) return null;
          return splitPageData(data).layers;
        },
        [`layers-/${slugPath}`, keySuffix],
        opts
      )(),
    ]);

    if (!core) return null;
    return reassemblePageData(core, layers || []);
  } catch {
    try {
      return await fetchPageByPath(slugPath, true);
    } catch {
      return null;
    }
  }
}

async function fetchPublishedPageForMetadata(slugPath: string) {
  const { effectiveTid, keySuffix } = await getTenantCacheContext();
  return unstable_cache(
    async () => fetchPageByPathForMetadata(slugPath, true),
    [`metadata-/${slugPath}`, keySuffix],
    {
      tags: [
        tenantAllPagesTag(effectiveTid),
        tenantRouteTag(effectiveTid, slugPath),
      ],
      revalidate: false,
    }
  )();
}

async function fetchCachedRedirects(): Promise<RedirectType[] | null> {
  const { effectiveTid, keySuffix } = await getTenantCacheContext();
  try {
    return await unstable_cache(
      async () => getSettingByKey('redirects') as Promise<RedirectType[] | null>,
      ['data-for-redirects', keySuffix],
      { tags: [tenantAllPagesTag(effectiveTid)], revalidate: false }
    )();
  } catch {
    return null;
  }
}

async function fetchCachedGlobalSettings() {
  const { effectiveTid, keySuffix } = await getTenantCacheContext();
  try {
    return await unstable_cache(
      async () => fetchGlobalPageSettings(),
      ['data-for-global-settings', keySuffix],
      { tags: [tenantAllPagesTag(effectiveTid)], revalidate: false }
    )();
  } catch {
    return {
      googleSiteVerification: null,
      globalCanonicalUrl: null,
      gaMeasurementId: null,
      publishedCss: null,
      colorVariablesCss: null,
      globalCustomCodeHead: null,
      globalCustomCodeBody: null,
      ycodeBadge: true,
      faviconUrl: null,
      webClipUrl: null,
    };
  }
}

async function fetchCachedFoldersForAuth() {
  const { effectiveTid, keySuffix } = await getTenantCacheContext();
  try {
    return await unstable_cache(
      async () => fetchFoldersForAuth(true),
      ['data-for-auth-folders', keySuffix],
      { tags: [tenantAllPagesTag(effectiveTid)], revalidate: false }
    )();
  } catch {
    return [];
  }
}

async function fetchCachedErrorPage(errorCode: 401 | 404) {
  const { effectiveTid, keySuffix } = await getTenantCacheContext();
  try {
    return await unstable_cache(
      async () => {
        const data = await fetchErrorPage(errorCode, true);
        return data ? slimPageData(data) : null;
      },
      [`error-${errorCode}`, keySuffix],
      { tags: [tenantAllPagesTag(effectiveTid)], revalidate: false }
    )();
  } catch {
    return null;
  }
}

interface PageProps {
  params: Promise<{ slug: string | string[] }>;
}

export default async function Page({ params }: PageProps) {
  // Await params
  const { slug } = await params;

  // Handle catch-all slug (join array into path)
  const slugPath = Array.isArray(slug) ? slug.join('/') : slug;

  // Tag this response for Vercel CDN cache invalidation. The publish endpoint
  // purges this exact tag (route-/<slug>) so only this URL's cache entry is
  // invalidated. No-ops outside Vercel.
  await addCacheTag([`route-/${slugPath}`, 'all-pages']);

  // Check for redirects before processing the page
  const currentPath = `/${slugPath}`;
  const redirects = await fetchCachedRedirects();
  if (redirects && Array.isArray(redirects)) {
    const matched = matchRedirect(currentPath, redirects);
    if (matched) {
      if (matched.type === '302') {
        redirect(matched.newUrl);
      } else {
        permanentRedirect(matched.newUrl);
      }
    }
  }

  // Fetch page data and global settings in parallel
  const [data, globalSettings] = await Promise.all([
    fetchPublishedPageWithLayers(slugPath),
    fetchCachedGlobalSettings(),
  ]);

  // Page not found: hand off to the 404 boundary so the response carries a real
  // HTTP 404 status (the custom 404 page is rendered there). Returning content
  // here would emit a 200 "soft 404", which search engines penalize.
  if (!data) {
    notFound();
  }

  const { page, pageLayers, components, collectionItem, collectionFields, pageCollectionSortedItemIds, pageCollectionSortedItemSlugs, locale, availableLocales, translations, generatedCss } = data;

  // Per-page CSS with fallback to global published_css
  const cssForPage = generatedCss || globalSettings.publishedCss || undefined;

  // Check password protection for this page.
  // First evaluate without cookies() so non-protected pages stay cacheable.
  const folders = await fetchCachedFoldersForAuth();
  const protectionCheck = getPasswordProtection(page, folders, null);

  // If page is protected, opt into dynamic rendering and read the auth cookie.
  if (protectionCheck.isProtected) {
    await connection();
    const authCookie = await parseAuthCookie();
    const protection = getPasswordProtection(page, folders, authCookie);

    // If page is protected and not unlocked, show 401 error page
    if (!protection.isUnlocked) {
      const errorPageData = await fetchCachedErrorPage(401);

      if (errorPageData) {
        const { page: errorPage, pageLayers: errorPageLayers, components: errorComponents } = errorPageData;

        return (
          <PageRenderer
            page={errorPage}
            layers={errorPageLayers.layers || []}
            components={errorComponents}
            generatedCss={globalSettings.publishedCss || undefined}
            colorVariablesCss={globalSettings.colorVariablesCss || undefined}
            globalCustomCodeHead={globalSettings.globalCustomCodeHead}
            globalCustomCodeBody={globalSettings.globalCustomCodeBody}
            ycodeBadge={globalSettings.ycodeBadge}
            passwordProtection={{
              pageId: protection.protectedBy === 'page' ? protection.protectedById : undefined,
              folderId: protection.protectedBy === 'folder' ? protection.protectedById : undefined,
              redirectUrl: currentPath,
              isPublished: true,
            }}
          />
        );
      }

      // Inline fallback if no custom 401 page exists
      return (
        <div className="min-h-screen flex items-center justify-center bg-white">
          <div className="text-center max-w-md px-4">
            <h1 className="text-6xl font-bold text-gray-900 mb-4">401</h1>
            <h2 className="text-2xl font-semibold text-gray-800 mb-4">Password Protected</h2>
            <p className="text-gray-600 mb-8">Enter the password to continue.</p>
            <PasswordForm
              pageId={protection.protectedBy === 'page' ? protection.protectedById : undefined}
              folderId={protection.protectedBy === 'folder' ? protection.protectedById : undefined}
              redirectUrl={currentPath}
              isPublished={true}
            />
          </div>
        </div>
      );
    }
  }

  return (
    <PageRenderer
      page={page}
      layers={pageLayers.layers || []}
      components={components}
      generatedCss={cssForPage}
      colorVariablesCss={globalSettings.colorVariablesCss || undefined}
      collectionItem={collectionItem}
      collectionFields={collectionFields}
      pageCollectionSortedItemIds={pageCollectionSortedItemIds}
      pageCollectionSortedItemSlugs={pageCollectionSortedItemSlugs}
      locale={locale}
      availableLocales={availableLocales}
      translations={translations}
      gaMeasurementId={globalSettings.gaMeasurementId}
      globalCustomCodeHead={globalSettings.globalCustomCodeHead}
      globalCustomCodeBody={globalSettings.globalCustomCodeBody}
      ycodeBadge={globalSettings.ycodeBadge}
    />
  );
}

// Generate metadata
export async function generateMetadata({ params }: { params: Promise<{ slug: string | string[] }> }): Promise<Metadata> {
  const { slug } = await params;

  // Handle catch-all slug (join array into path)
  const slugPath = Array.isArray(slug) ? slug.join('/') : slug;

  // Fetch page and global settings in parallel
  const [data, globalSettings] = await Promise.all([
    fetchPublishedPageForMetadata(slugPath),
    fetchCachedGlobalSettings(),
  ]);

  if (!data) {
    return {
      title: 'Page Not Found',
      robots: { index: false, follow: false },
    };
  }

  // Don't leak metadata for protected pages. Checking without cookies keeps
  // generateMetadata fully static — no need to verify unlock state here since
  // the page component handles access gating.
  const folders = await fetchCachedFoldersForAuth();
  const protectionCheck = getPasswordProtection(data.page, folders, null);

  if (protectionCheck.isProtected) {
    return {
      title: 'Password Protected',
      description: 'This page is password protected.',
      robots: { index: false, follow: false },
    };
  }

  const { effectiveTid, keySuffix } = await getTenantCacheContext();
  const { meta, baseUrl } = await unstable_cache(
    async () => ({
      meta: await generatePageMetadata(data.page, {
        fallbackTitle: slugPath.charAt(0).toUpperCase() + slugPath.slice(1),
        collectionItem: data.collectionItem,
        pagePath: '/' + slugPath,
        globalSeoSettings: globalSettings,
      }),
      baseUrl: getSiteBaseUrl({ globalCanonicalUrl: globalSettings.globalCanonicalUrl }),
    }),
    [`data-for-route-/${slugPath}-meta`, keySuffix],
    {
      tags: [
        tenantAllPagesTag(effectiveTid),
        tenantRouteTag(effectiveTid, slugPath),
      ],
      revalidate: false,
    }
  )();

  if (baseUrl) {
    try { meta.metadataBase = new URL(baseUrl); } catch { /* invalid URL */ }
  }

  return meta;
}
