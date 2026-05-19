import { redirect, permanentRedirect } from 'next/navigation';
import { unstable_cache } from 'next/cache';
import { addCacheTag } from '@vercel/functions';
import Link from 'next/link';
import { cache } from 'react';
import { fetchHomepage, fetchErrorPage, splitPageData, reassemblePageData, slimPageData } from '@/lib/page-fetcher';
import type { PageData } from '@/lib/page-fetcher';
import PageRenderer from '@/components/PageRenderer';
import PasswordForm from '@/components/PasswordForm';
import { generatePageMetadata, fetchGlobalPageSettings } from '@/lib/generate-page-metadata';
import { getSettingByKey } from '@/lib/repositories/settingsRepository';
import { matchRedirect } from '@/lib/redirect-utils';
import { parseAuthCookie, getPasswordProtection, fetchFoldersForAuth } from '@/lib/page-auth';
import { resolveEffectiveTenantId } from '@/lib/masjidweb/effective-tenant-id';
import {
  tenantAllPagesTag,
  tenantRouteTag,
} from '@/lib/masjidweb/tenant-cache-tags';
import { getSiteBaseUrl } from '@/lib/url-utils';
import type { Redirect as RedirectType } from '@/types';
import type { Metadata } from 'next';

// Avoid ISR full-route caching on Netlify (stale HTML after publish). Data uses
// unstable_cache + tenant-scoped revalidateTag on publish.
export const dynamic = 'force-dynamic';
export const revalidate = 0;

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
 * Fetch homepage data from database
 * Cached with tag-based revalidation (no time-based stale cache)
 */
async function fetchPublishedHomepage() {
<<<<<<< HEAD
  const { effectiveTid, keySuffix } = await getTenantCacheContext();
  const tags = [
    tenantAllPagesTag(effectiveTid),
    tenantRouteTag(effectiveTid, '/'),
  ];
=======
  // Tags are both 'route-/' AND 'all-pages':
  // - route-/ lets selective invalidation purge just this page's data cache
  // - all-pages lets full invalidation (color variables, redirects, etc.)
  //   sweep every page's data cache in one invalidateByTag call.
  // Vercel's invalidateByTag is tag-precise, so no cascade — selective
  // invalidation of one route doesn't disturb others. (Next.js bug #63509
  // would apply if we used revalidateTag for selective on Vercel, but we
  // route exclusively through invalidateByTag here.)
  const tags = ['route-/', 'all-pages'];
>>>>>>> upstream/main
  const opts = { tags, revalidate: false as const };

  try {
    const [core, layers] = await Promise.all([
      unstable_cache(
        async () => {
          const data = await fetchHomepage(true);
          if (!data) return null;
          return splitPageData(data as PageData).core;
        },
        ['core-/', keySuffix],
        opts
      )(),
      unstable_cache(
        async () => {
          const data = await fetchHomepage(true);
          if (!data) return null;
          return splitPageData(data as PageData).layers;
        },
        ['layers-/', keySuffix],
        opts
      )(),
    ]);

    if (!core) return null;
    return reassemblePageData(core, layers || []);
  } catch {
    try {
      return await fetchHomepage(true);
    } catch {
      return null;
    }
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

async function fetchCachedRedirects(): Promise<RedirectType[] | null> {
  try {
    return await unstable_cache(
      async () => getSettingByKey('redirects') as Promise<RedirectType[] | null>,
      ['data-for-redirects'],
      { tags: ['all-pages'], revalidate: false }
    )();
  } catch {
    return null;
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

async function fetchCachedErrorPage(errorCode: 401) {
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

export default async function Home() {
  // Tag this response for Vercel CDN cache invalidation. The publish endpoint
  // purges this exact tag (route-/) so only the homepage cache entry is
  // invalidated. No-ops outside Vercel.
  await addCacheTag(['route-/', 'all-pages']);

  // Check for redirects targeting the homepage
  const redirects = await fetchCachedRedirects();
  if (redirects && Array.isArray(redirects)) {
    const matched = matchRedirect('/', redirects);
    if (matched) {
      if (matched.type === '302') {
        redirect(matched.newUrl);
      } else {
        permanentRedirect(matched.newUrl);
      }
    }
  }

  // Cache-first homepage path; pagination is served through internal dynamic routes.
  const data = await fetchPublishedHomepage();

  // If no published homepage exists, show default landing page
  if (!data || !data.pageLayers) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-white">
        <div className="text-center p-8 flex flex-col items-center justify-center gap-2">
          <h1 className="text-xl font-semibold text-neutral-900">
            Welcome to Ycode
          </h1>
          <Link
            href="/ycode"
            className=" bg-blue-500 text-white text-sm font-medium h-8 flex items-center justify-center px-3 rounded-lg transition-colors"
          >
            Get started
          </Link>
        </div>
      </div>
    );
  }

  // Load all global settings early so error pages also get global custom code
  const globalSettings = await fetchCachedGlobalSettings();

  // Per-page CSS with fallback to global published_css
  const cssForPage = data.generatedCss || globalSettings.publishedCss || undefined;

  // Check password protection for homepage.
  // First evaluate without cookies() so non-protected pages can stay cacheable.
  const folders = await fetchCachedFoldersForAuth();
  const protectionCheck = getPasswordProtection(data.page, folders, null);

  // If homepage is protected, read auth cookie and re-check unlock state.
  if (protectionCheck.isProtected) {
    const authCookie = await parseAuthCookie();
    const protection = getPasswordProtection(data.page, folders, authCookie);

    // If homepage is protected and not unlocked, show 401 error page
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
            passwordProtection={{
              pageId: protection.protectedBy === 'page' ? protection.protectedById : undefined,
              folderId: protection.protectedBy === 'folder' ? protection.protectedById : undefined,
              redirectUrl: '/',
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
              redirectUrl="/"
              isPublished={true}
            />
          </div>
        </div>
      );
    }
  }

  // Render homepage
  return (
    <PageRenderer
      page={data.page}
      layers={data.pageLayers.layers || []}
      components={data.components}
      generatedCss={cssForPage}
      colorVariablesCss={globalSettings.colorVariablesCss || undefined}
      locale={data.locale}
      availableLocales={data.availableLocales}
      translations={data.translations}
      gaMeasurementId={globalSettings.gaMeasurementId}
      globalCustomCodeHead={globalSettings.globalCustomCodeHead}
      globalCustomCodeBody={globalSettings.globalCustomCodeBody}
      ycodeBadge={globalSettings.ycodeBadge}
    />
  );
}

// Generate metadata
export async function generateMetadata(): Promise<Metadata> {
  // Fetch page and global settings in parallel
  const [data, globalSettings] = await Promise.all([
    fetchPublishedHomepage(),
    fetchCachedGlobalSettings(),
  ]);

  if (!data) {
    return {
      title: 'Ycode',
      description: 'Built with Ycode',
    };
  }

  // Check password protection - don't leak metadata for protected pages.
  // First check without cookies() to avoid forcing dynamic metadata for public pages.
  const folders = await fetchCachedFoldersForAuth();
  const protectionCheck = getPasswordProtection(data.page, folders, null);

  if (protectionCheck.isProtected) {
    const authCookie = await parseAuthCookie();
    const protection = getPasswordProtection(data.page, folders, authCookie);
    if (!protection.isUnlocked) {
      return {
        title: 'Password Protected',
        description: 'This page is password protected.',
        robots: { index: false, follow: false },
      };
    }
  }

  const { effectiveTid, keySuffix } = await getTenantCacheContext();
  const { meta, baseUrl } = await unstable_cache(
    async () => ({
      meta: await generatePageMetadata(data.page, {
        fallbackTitle: 'Home',
        pagePath: '/',
        globalSeoSettings: globalSettings,
      }),
      baseUrl: getSiteBaseUrl({ globalCanonicalUrl: globalSettings.globalCanonicalUrl }),
    }),
<<<<<<< HEAD
    ['data-for-route-/-meta', keySuffix],
    {
      tags: [
        tenantAllPagesTag(effectiveTid),
        tenantRouteTag(effectiveTid, '/'),
      ],
      revalidate: false,
    }
=======
    ['data-for-route-/-meta'],
    { tags: ['route-/', 'all-pages'], revalidate: false }
>>>>>>> upstream/main
  )();

  if (baseUrl) {
    try { meta.metadataBase = new URL(baseUrl); } catch { /* invalid URL */ }
  }

  return meta;
}
