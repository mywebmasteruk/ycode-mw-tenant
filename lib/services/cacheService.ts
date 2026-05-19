import { revalidateTag, revalidatePath } from 'next/cache';
<<<<<<< HEAD
import { resolveEffectiveTenantId } from '@/lib/masjidweb/effective-tenant-id';
import {
  tenantAllPagesTag,
  tenantRouteTag,
} from '@/lib/masjidweb/tenant-cache-tags';
=======
import { invalidateByTag } from '@vercel/functions';
import { getSupabaseAdmin } from '@/lib/supabase-server';
import { buildSlugPath } from '@/lib/page-utils';
import type { Page, PageFolder } from '@/types';

/**
 * Maximum number of routes to warm in a single invalidation event.
 *
 * Warming is a best-effort optimisation, not a correctness requirement —
 * the long tail of routes will self-warm on their first real visit. The
 * cap protects against runaway cost when a dynamic page expands to
 * hundreds of CMS items, and against Vercel function timeout limits.
 */
const MAX_ROUTES_TO_WARM = 50;

type SupabaseAdmin = NonNullable<Awaited<ReturnType<typeof getSupabaseAdmin>>>;

const SUPABASE_IN_LIMIT = 500;

/** Split an array into chunks safe for Supabase `.in()` queries. */
function chunk<T>(arr: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size));
  }
  return chunks;
}
>>>>>>> upstream/main

/**
 * Cache Invalidation Service
 *
<<<<<<< HEAD
 * Netlify: revalidateTag clears Next data cache; optional REST purge clears Edge when configured.
=======
 * Handles CDN cache invalidation for published pages using Next.js revalidation.
 * Supports both full-site invalidation and selective per-page invalidation.
>>>>>>> upstream/main
 */

/** Legacy tag when tenant id is unknown (single-tenant / admin scripts). */
const ALL_PAGES_CACHE_TAG = 'all-pages';

function netlifyPurgeCredentials(): {
  token: string | undefined;
  siteId: string | undefined;
  siteSlug: string | undefined;
  } {
  const token =
    process.env.NETLIFY_PURGE_API_TOKEN?.trim() ||
    process.env.NETLIFY_TOKEN?.trim() ||
    process.env.NETLIFY_AUTH_TOKEN?.trim();
  const siteId =
    process.env.NETLIFY_SITE_ID?.trim() ||
    process.env.SITE_ID?.trim();
  const siteSlug = process.env.SITE_NAME?.trim();
  return { token, siteId, siteSlug };
}

/**
<<<<<<< HEAD
 * @param publisherTenantId - When set, purge only that tenant's tagged HTML (see proxy
 *   Netlify-Cache-Tag). Avoids invalidating other tenants on the same Netlify site.
=======
 * Invalidate cache for a specific page by route path.
 *
 * On Vercel: uses invalidateByTag exclusively, which talks directly to Vercel's
 * CDN purge API and covers all three cache layers (CDN, Runtime, Data). We
 * deliberately avoid revalidateTag here because Next.js bug #63509 causes it
 * to cascade-invalidate other tags consumed by the page render, breaking
 * selective invalidation on Vercel.
 *
 * On self-hosted (no Vercel runtime): invalidateByTag no-ops, so we fall
 * back to revalidateTag to clear the in-process Next.js data cache.
 *
 * @param routePath - Route path (without leading slash for tag, with for path)
>>>>>>> upstream/main
 */
export async function purgeNetlifyEdgeCache(
  publisherTenantId?: string | null,
): Promise<{
  method: string;
  ok: boolean;
  error?: string;
}> {
  const diagnostics: string[] = [];
  const { token, siteId, siteSlug } = netlifyPurgeCredentials();
  const tid = publisherTenantId?.trim() || null;
  const tenantScoped = Boolean(tid);
  const cacheTags = [tid ? tenantAllPagesTag(tid) : ALL_PAGES_CACHE_TAG];
  diagnostics.push(
    `env: purge_token=${token ? 'set' : 'missing'}, site_id=${siteId || 'missing'}, site_name=${siteSlug || 'missing'}, tags=${cacheTags.join(',')}`,
  );

  if (!token) {
    const msg =
      'no purge token (set NETLIFY_PURGE_API_TOKEN to purge by tag after publish; public HTML uses Cache-Control: private so shared edge caches do not retain stale pages)';
    diagnostics.push(msg);
    console.warn(`⚠️ [Cache] ${msg}`);
    return { method: 'none', ok: false, error: diagnostics.join(' | ') };
  }

  let purgeCache: (opts: {
    token: string;
    siteID?: string;
    siteSlug?: string;
    tags?: string[];
  }) => Promise<void>;
  try {
    purgeCache = (await import('@netlify/functions')).purgeCache;
  } catch (importErr) {
    const msg = `import @netlify/functions failed: ${importErr instanceof Error ? importErr.message : String(importErr)}`;
    diagnostics.push(msg);
    console.warn(`⚠️ [Cache] ${msg}`);
    return { method: 'none', ok: false, error: diagnostics.join(' | ') };
  }

  const attempts: Array<{ label: string; run: () => Promise<void> }> = [];

  if (siteId) {
    attempts.push({
      label: 'purgeCache-tags+siteID',
      run: () =>
        purgeCache({
          token,
          siteID: siteId,
          tags: cacheTags,
        }),
    });
    // Full-site purge would invalidate every tenant on this Netlify deploy — only for legacy/global.
    if (!tenantScoped) {
      attempts.push({
        label: 'purgeCache-siteID',
        run: () => purgeCache({ token, siteID: siteId }),
      });
    }
  }

  if (siteSlug) {
    attempts.push({
      label: 'purgeCache-tags+siteSlug',
      run: () =>
        purgeCache({
          token,
          siteSlug,
          tags: cacheTags,
        }),
    });
    if (!tenantScoped) {
      attempts.push({
        label: 'purgeCache-siteSlug',
        run: () => purgeCache({ token, siteSlug }),
      });
    }
  }

  for (const { label, run } of attempts) {
    try {
      await run();
      console.log(`✅ [Cache] Netlify edge purged via ${label}`);
      return { method: label, ok: true };
    } catch (err) {
      diagnostics.push(`${label}: ${err}`);
    }
  }

  if (siteId) {
    try {
      const res = await fetch('https://api.netlify.com/api/v1/purge', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          site_id: siteId,
          cache_tags: cacheTags,
        }),
      });
      if (res.ok) {
        console.log('✅ [Cache] Netlify edge purged via REST API (cache_tags)');
        return { method: 'rest-api-tags', ok: true };
      }
      const text = await res.text().catch(() => '');
      diagnostics.push(`REST tags: ${res.status} ${text}`);
    } catch (err) {
      diagnostics.push(`REST tags fetch: ${err}`);
    }

    if (!tenantScoped) {
      try {
        const res = await fetch('https://api.netlify.com/api/v1/purge', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({ site_id: siteId }),
        });
        if (res.ok) {
          console.log('✅ [Cache] Netlify edge purged via REST API (site)');
          return { method: 'rest-api-site', ok: true };
        }
        const text = await res.text().catch(() => '');
        diagnostics.push(`REST site: ${res.status} ${text}`);
      } catch (err) {
        diagnostics.push(`REST site fetch: ${err}`);
      }
    }
  }

  const error = diagnostics.join(' | ');
  console.error('❌ [Cache] All Netlify edge purge methods failed:', error);
  return { method: 'none', ok: false, error };
}

export async function invalidatePage(routePath: string): Promise<boolean> {
  const tag = `route-/${routePath}`;
  try {
<<<<<<< HEAD
    const effectiveTid = await resolveEffectiveTenantId();
    const normalized = routePath.replace(/^\/+/, '');
    revalidateTag(tenantRouteTag(effectiveTid, normalized || '/'), 'max');
    revalidatePath(normalized ? `/${normalized}` : '/', 'page');
=======
    if (process.env.VERCEL === '1') {
      await invalidateByTag(tag);
    } else {
      revalidateTag(tag, { expire: 0 });
    }
>>>>>>> upstream/main
    return true;
  } catch (error) {
    console.error('❌ [Cache] Invalidation error:', error);
    return false;
  }
}

<<<<<<< HEAD
export async function invalidatePages(routePaths: string[]): Promise<boolean> {
  const results = await Promise.all(
    routePaths.map((routePath) => invalidatePage(routePath)),
  );
  return results.every(Boolean);
=======
/**
 * Invalidate cache for multiple pages.
 * Uses Vercel's batched invalidateByTag on Vercel, revalidateTag elsewhere.
 *
 * @param routePaths - Array of route paths
 */
export async function invalidatePages(routePaths: string[]): Promise<boolean> {
  if (routePaths.length === 0) return true;
  try {
    const tags = routePaths.map((p) => `route-/${p}`);
    if (process.env.VERCEL === '1') {
      await invalidateByTag(tags);
    } else {
      for (const tag of tags) {
        revalidateTag(tag, { expire: 0 });
      }
    }
    return true;
  } catch (error) {
    console.error('❌ [Cache] Invalidation error:', error);
    return false;
  }
>>>>>>> upstream/main
}

export async function clearAllCache(
  publisherTenantId?: string | null,
): Promise<Record<string, unknown>> {
  const tid = publisherTenantId?.trim() || null;
  let nextCacheNote: string | undefined;
  try {
<<<<<<< HEAD
    // Next.js 16 expects a profile string (e.g. "max"); invalid profile or missing
    // incrementalCache on some hosts must not fail the whole publish pipeline.
    revalidateTag(tenantAllPagesTag(tid), 'max');
    revalidateTag(tenantRouteTag(tid, '/'), 'max');
    revalidatePath('/', 'layout');
    revalidatePath('/', 'page');
=======
    if (process.env.VERCEL === '1') {
      // Vercel: direct CDN purge by the 'all-pages' tag set on every page
      // response. Covers CDN, Runtime, and Data caches in one call. Avoids
      // revalidateTag's cascade bug (#63509).
      await invalidateByTag('all-pages');
    } else {
      // Self-hosted: clear Next.js's in-process caches.
      revalidateTag('all-pages', { expire: 0 });
      revalidatePath('/', 'layout');
    }
>>>>>>> upstream/main
  } catch (error) {
    nextCacheNote =
      error instanceof Error ? error.message : String(error);
    console.warn('⚠️ [Cache] Next revalidate skipped (non-fatal):', nextCacheNote);
  }

  const purge = await purgeNetlifyEdgeCache(tid);
  return {
    ...purge,
    publisherTenantId: tid,
    ...(nextCacheNote ? { nextJsRevalidateNote: nextCacheNote } : {}),
  };
}

/**
 * Resolve published page IDs to their route paths (for cache invalidation).
 * Returns all URL paths each page can be reached at, including locale variants.
 *
 * For dynamic pages, enumerates actual collection item slugs rather than
 * returning a {slug} placeholder (which would never match a real cache tag).
 */
export async function getRoutePathsForPages(pageIds: string[]): Promise<string[]> {
  if (pageIds.length === 0) return [];

  const client = await getSupabaseAdmin();
  if (!client) return [];

  const [
    { data: pages },
    { data: folders },
    { data: locales },
    { data: translations },
  ] = await Promise.all([
    client.from('pages').select('*').in('id', pageIds).eq('is_published', true).is('deleted_at', null),
    client.from('page_folders').select('*').eq('is_published', true).is('deleted_at', null),
    client.from('locales').select('*').is('deleted_at', null),
    client.from('translations').select('*').eq('is_published', true).is('deleted_at', null),
  ]);

  if (!pages || !folders) return [];

  const routePaths: string[] = [];
  const dynamicPages: Page[] = [];

  // Build translations lookup
  const translationsMap: Record<string, Record<string, string>> = {};
  if (translations) {
    for (const t of translations) {
      if (!translationsMap[t.locale_id]) translationsMap[t.locale_id] = {};
      const key = `${t.source_type}:${t.source_id}:${t.content_key}`;
      translationsMap[t.locale_id][key] = t.content_value;
    }
  }

  for (const page of pages as Page[]) {
    if (page.is_dynamic) {
      dynamicPages.push(page);
      continue;
    }

    // Default locale path
    const defaultPath = buildSlugPath(page, folders as PageFolder[], 'page');
    const trimmed = defaultPath.slice(1); // Remove leading "/"

    if (page.is_index && page.page_folder_id === null) {
      routePaths.push('');
    } else if (trimmed) {
      routePaths.push(trimmed);
    }

    // Locale variant paths
    if (locales) {
      for (const locale of locales) {
        if (locale.is_default) continue;
        const localeTranslations = translationsMap[locale.id] || {};

        const slugParts: string[] = [locale.code];

        let currentFolderId = page.page_folder_id;
        const folderSegments: string[] = [];
        while (currentFolderId) {
          const folder = (folders as PageFolder[]).find(f => f.id === currentFolderId);
          if (!folder) break;
          const tKey = `folder:${folder.id}:slug`;
          folderSegments.unshift(localeTranslations[tKey] || folder.slug);
          currentFolderId = folder.page_folder_id;
        }
        slugParts.push(...folderSegments);

        if (!page.is_index && page.slug) {
          const pageKey = `page:${page.id}:slug`;
          slugParts.push(localeTranslations[pageKey] || page.slug);
        }

        const localePath = slugParts.filter(Boolean).join('/');
        if (localePath) routePaths.push(localePath);
      }
    }
  }

  // Resolve actual URLs for dynamic pages by enumerating collection item slugs
  if (dynamicPages.length > 0) {
    const dynamicRoutes = await resolveDynamicPageRoutes(
      client, dynamicPages, folders as PageFolder[], locales || [], translationsMap,
    );
    routePaths.push(...dynamicRoutes);
  }

  return [...new Set(routePaths)];
}

/**
 * Enumerate all published instance URLs for dynamic (CMS-driven) pages.
 * Each dynamic page is bound to a collection; we look up the slug field
 * values of published items to build the real URL paths.
 */
async function resolveDynamicPageRoutes(
  client: SupabaseAdmin,
  dynamicPages: Page[],
  folders: PageFolder[],
  locales: Array<{ id: string; code: string; is_default: boolean }>,
  translationsMap: Record<string, Record<string, string>>,
): Promise<string[]> {
  const routes: string[] = [];

  for (const page of dynamicPages) {
    const collectionId = (page.settings as any)?.cms?.collection_id;
    if (!collectionId) continue;

    const { data: slugField } = await client
      .from('collection_fields')
      .select('id')
      .eq('collection_id', collectionId)
      .eq('key', 'slug')
      .is('deleted_at', null)
      .limit(1)
      .single();

    if (!slugField) continue;

    const { data: items } = await client
      .from('collection_items')
      .select('id')
      .eq('collection_id', collectionId)
      .eq('is_published', true)
      .is('deleted_at', null);

    if (!items || items.length === 0) continue;

    const itemIds = items.map(i => i.id);
    const slugValues: Array<{ item_id: string; value: unknown }> = [];
    for (const idChunk of chunk(itemIds, SUPABASE_IN_LIMIT)) {
      const { data } = await client
        .from('collection_item_values')
        .select('item_id, value')
        .eq('field_id', slugField.id)
        .eq('is_published', true)
        .is('deleted_at', null)
        .in('item_id', idChunk);
      if (data) slugValues.push(...data);
    }

    if (slugValues.length === 0) continue;

    // Folder base path (everything before the {slug} segment)
    const basePath = buildSlugPath(page, folders, 'page', '').slice(1).replace(/\/$/, '');

    for (const sv of slugValues) {
      if (!sv.value) continue;
      const itemSlug = sv.value as string;
      const fullPath = basePath ? `${basePath}/${itemSlug}` : itemSlug;
      routes.push(fullPath);

      // Locale variant paths for each item
      for (const locale of locales) {
        if (locale.is_default) continue;
        const lt = translationsMap[locale.id] || {};

        const slugParts: string[] = [locale.code];
        let currentFolderId = page.page_folder_id;
        const folderSegments: string[] = [];
        while (currentFolderId) {
          const folder = folders.find(f => f.id === currentFolderId);
          if (!folder) break;
          folderSegments.unshift(lt[`folder:${folder.id}:slug`] || folder.slug);
          currentFolderId = folder.page_folder_id;
        }
        slugParts.push(...folderSegments);
        slugParts.push(itemSlug);

        const localePath = slugParts.filter(Boolean).join('/');
        if (localePath) routes.push(localePath);
      }
    }
  }

  return routes;
}

/**
 * Build route paths for deleted CMS items from their old slug values.
 * Maps each collection's deleted slugs to the dynamic pages that use that
 * collection, constructing the full URL paths that should be invalidated.
 *
 * @param deletedSlugs - Map of collectionId → array of deleted item slug values
 */
export async function getRoutePathsForDeletedCollectionItems(
  deletedSlugs: Map<string, string[]>,
): Promise<string[]> {
  if (deletedSlugs.size === 0) return [];

  const client = await getSupabaseAdmin();
  if (!client) return [];

  const routes: string[] = [];

  const [
    { data: dynamicPages },
    { data: folders },
    { data: locales },
  ] = await Promise.all([
    client.from('pages').select('*').eq('is_published', true).eq('is_dynamic', true).is('deleted_at', null),
    client.from('page_folders').select('*').eq('is_published', true).is('deleted_at', null),
    client.from('locales').select('*').is('deleted_at', null),
  ]);

  if (!dynamicPages || !folders) return [];

  for (const page of dynamicPages as Page[]) {
    const collectionId = (page.settings as any)?.cms?.collection_id;
    if (!collectionId) continue;

    const slugs = deletedSlugs.get(collectionId);
    if (!slugs || slugs.length === 0) continue;

    const basePath = buildSlugPath(page, folders as PageFolder[], 'page', '').slice(1).replace(/\/$/, '');

    for (const itemSlug of slugs) {
      const fullPath = basePath ? `${basePath}/${itemSlug}` : itemSlug;
      routes.push(fullPath);

      // Locale-prefixed paths
      if (locales) {
        for (const locale of locales) {
          if (locale.is_default) continue;
          const slugParts: string[] = [locale.code];
          let currentFolderId = page.page_folder_id;
          const folderSegments: string[] = [];
          while (currentFolderId) {
            const folder = (folders as PageFolder[]).find(f => f.id === currentFolderId);
            if (!folder) break;
            folderSegments.unshift(folder.slug);
            currentFolderId = folder.page_folder_id;
          }
          slugParts.push(...folderSegments);
          slugParts.push(itemSlug);
          const localePath = slugParts.filter(Boolean).join('/');
          if (localePath) routes.push(localePath);
        }
      }
    }
  }

  return [...new Set(routes)];
}

/**
 * Invalidate cache for pages affected by a change to a single CMS collection.
 *
 * Used by external integrations that mutate published collection items without
 * going through the builder's publish flow (v1 REST API, Webflow sync, etc.).
 *
 * Covers two kinds of dependents:
 *   - Pages that render a collection-list/collection-grid block of this collection.
 *   - The dynamic page bound to this collection (one URL per published item).
 *
 * For deletes and slug renames, pass the pre-mutation slug(s) in `removedSlugs`
 * so we can invalidate the old URL — once the item is soft-deleted or renamed,
 * `getRoutePathsForPages` no longer enumerates it, and the CDN would keep
 * serving the deleted/old content as a 200.
 */
export async function invalidateForCollectionChange(
  collectionId: string,
  options: { removedSlugs?: string[] } = {},
): Promise<{ invalidatedRoutes: string[] }> {
  const { findAffectedPages } = await import('@/lib/repositories/pageLayersRepository');

  const affected = await findAffectedPages([], [], [collectionId]);
  const pageIds = affected.collectionPageIds;

  const liveRoutes = pageIds.length > 0 ? await getRoutePathsForPages(pageIds) : [];

  const removedRoutes = (options.removedSlugs && options.removedSlugs.length > 0)
    ? await getRoutePathsForDeletedCollectionItems(new Map([[collectionId, options.removedSlugs]]))
    : [];

  const routes = [...new Set([...liveRoutes, ...removedRoutes])];

  if (routes.length > 0) {
    await invalidatePages(routes);
  }

  return { invalidatedRoutes: routes };
}

export interface SelectiveInvalidationResult {
  strategy: 'selective' | 'full';
  invalidatedRoutes: string[];
  reason?: string;
}

/**
 * Perform selective cache invalidation based on what actually changed.
 *
 * Receives the exact page IDs that were modified during publish (content_hash
 * changed, new page, or folder moved) — no guessing via timestamps.
 * Falls back to full invalidation when global resources changed.
 *
 * @param changedPageIds - Page IDs that actually changed during publish (from publishPages)
 * @param globalChanged - Whether global resources changed (triggers full nuke)
 * @param indirectlyAffectedPageIds - Page IDs affected by component, style, or collection changes
 */
export async function selectiveInvalidation(
  changedPageIds: string[],
  globalChanged: boolean,
  indirectlyAffectedPageIds: string[] = [],
): Promise<SelectiveInvalidationResult> {
  if (globalChanged) {
    await clearAllCache();
    return { strategy: 'full', invalidatedRoutes: [], reason: 'global resources changed' };
  }

  const allAffectedIds = [...new Set([...changedPageIds, ...indirectlyAffectedPageIds])];

  if (allAffectedIds.length === 0) {
    return { strategy: 'selective', invalidatedRoutes: [], reason: 'no pages changed' };
  }

  const routePaths = await getRoutePathsForPages(allAffectedIds);

  if (routePaths.length > 0) {
    await invalidatePages(routePaths);
  }

  return { strategy: 'selective', invalidatedRoutes: routePaths };
}

/**
 * Resolve every URL the public site currently serves from published pages.
 * Includes static pages, locale variants, and every dynamic-page instance
 * (one URL per published CMS item).
 *
 * Used to warm the cache after a full invalidation so the first real
 * visitor doesn't pay the cold-cache cost.
 */
export async function getAllPublishedRoutes(): Promise<string[]> {
  const client = await getSupabaseAdmin();
  if (!client) return [];

  const { data: pages } = await client
    .from('pages')
    .select('id')
    .eq('is_published', true)
    .is('deleted_at', null);

  if (!pages || pages.length === 0) return [];

  return getRoutePathsForPages(pages.map((p) => p.id));
}

/**
 * Background-warm a set of routes by issuing GET requests to them, so the
 * next real visitor sees x-vercel-cache: HIT instead of STALE/MISS.
 *
 * Uses Vercel's waitUntil so warming runs AFTER the response is sent: zero
 * added latency on the triggering request. Capped at MAX_ROUTES_TO_WARM
 * to bound cost and stay within Vercel function lifetime limits — long
 * tail of routes self-warms on first real visit.
 *
 * Vercel-only: warming via internal fetch only makes sense when there's a
 * CDN in front of the function. No-ops elsewhere.
 *
 * @returns null if not on Vercel, no host header, no routes, or warming
 *   failed to schedule. Otherwise reports how many were warmed vs total.
 */
export async function warmRoutes(
  routes: string[],
  request: Request,
): Promise<{ warmed: number; total: number } | null> {
  if (process.env.VERCEL !== '1' || routes.length === 0) return null;

  const host = request.headers.get('x-forwarded-host') ?? request.headers.get('host');
  if (!host) return null;

  const proto = request.headers.get('x-forwarded-proto') ?? 'https';
  const baseUrl = `${proto}://${host}`;
  const toWarm = routes.slice(0, MAX_ROUTES_TO_WARM);

  try {
    const { waitUntil } = await import('@vercel/functions');
    waitUntil(
      Promise.allSettled(
        toWarm.map((route) =>
          fetch(`${baseUrl}/${route}`, {
            signal: AbortSignal.timeout(15000),
          }).catch(() => null),
        ),
      ),
    );
    return { warmed: toWarm.length, total: routes.length };
  } catch {
    return null;
  }
}
