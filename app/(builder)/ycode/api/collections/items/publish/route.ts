import { NextRequest, NextResponse } from 'next/server';
import { publishValues } from '@/lib/repositories/collectionItemValueRepository';
import { hardDeleteItem, getItemById } from '@/lib/repositories/collectionItemRepository';
import { getCollectionById } from '@/lib/repositories/collectionRepository';
import { cleanupDeletedCollections } from '@/lib/services/collectionService';
import { invalidateForCollectionsChange, clearAllCache, warmRoutes, getAllPublishedRoutes } from '@/lib/services/cacheService';
import { resolveEffectiveTenantId } from '@/lib/masjidweb/effective-tenant-id';
import { noCache } from '@/lib/api-response';

// Disable caching for this route
export const dynamic = 'force-dynamic';
export const revalidate = 0;
// MASJIDWEB_SEAM: netlify-cache-warming — on Netlify the post-purge cache
// warming below runs inline (see warmRouteChain), adding roughly one parallel
// page-render's wall time on top of the publish work; give the function room
// beyond the default timeout.
export const maxDuration = 60;
// MASJIDWEB_SEAM_END

/**
 * POST /ycode/api/collections/items/publish
 * Publish individual collection items by their IDs
 * - For normal items: Copies draft values to published values
 * - For deleted items (deleted_at set): Hard deletes the item and all values
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { item_ids } = body;
    
    if (!Array.isArray(item_ids)) {
      return noCache({ error: 'item_ids must be an array' }, 400);
    }
    
    let publishedCount = 0;
    const skipped: { itemId: string; reason: string }[] = [];
    // MASJIDWEB_SEAM: item-publish-invalidation — see docs/masjidweb-core-seams.md#tier-4.
    // Collections actually touched by a successful publish/delete below — the
    // v1 API's equivalent routes invalidate cache after every item write
    // (see app/(builder)/ycode/api/v1/collections/[collection_id]/items/[item_id]/route.ts),
    // but this builder-facing route never did, so the public page kept
    // serving stale content indefinitely after a normal "edit item, publish"
    // in the CMS UI — even once the underlying write itself succeeded.
    const changedCollectionIds = new Set<string>();
    // MASJIDWEB_SEAM_END

    // Publish each item
    for (const itemId of item_ids) {
      try {
        // Check if item is marked as deleted
        const item = await getItemById(itemId);

        if (!item) {
          skipped.push({ itemId, reason: 'item not found' });
          continue; // Item doesn't exist
        }

        if (item.deleted_at) {
          // Hard delete the item and all its values (CASCADE)
          await hardDeleteItem(itemId);
          // MASJIDWEB_SEAM: item-publish-invalidation (track)
          changedCollectionIds.add(item.collection_id);
          // MASJIDWEB_SEAM_END
          publishedCount++;
        } else {
          // Block publishing if the collection hasn't been published
          const publishedCollection = await getCollectionById(item.collection_id, true);
          if (!publishedCollection) {
            const reason = `collection ${item.collection_id} is not published`;
            console.warn(`Skipping item ${itemId}: ${reason}`);
            skipped.push({ itemId, reason });
            continue;
          }
          // Normal publish: copy draft values to published
          const valuesPublished = await publishValues(itemId);
          if (valuesPublished === 0) {
            skipped.push({ itemId, reason: 'no draft values found to publish' });
            continue;
          }
          // MASJIDWEB_SEAM: item-publish-invalidation (track)
          changedCollectionIds.add(item.collection_id);
          // MASJIDWEB_SEAM_END
          publishedCount++;
        }
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        console.error(`Error publishing item ${itemId}:`, error);
        skipped.push({ itemId, reason });
        // Continue with other items
      }
    }

    // Clean up any soft-deleted collections
    await cleanupDeletedCollections();

    // MASJIDWEB_SEAM: item-publish-invalidation — see docs/masjidweb-core-seams.md#tier-4.
    // Upstream has no cache invalidation in this route at all; everything from
    // here to the end of the warming block is fork-only.
    // Invalidate cached routes for every page that renders one of the
    // collections we touched, in a single batched call — not once per
    // collection in a loop. invalidateForCollectionChange (the singular form)
    // does several unpaginated whole-tenant table scans per call; looping it
    // over N distinct collections in one publish batch repeated all of that
    // scanning N times over data that hadn't changed between iterations
    // (found during self-review, given this codebase has already hit an 8s
    // PostgREST statement_timeout in production once before). Non-fatal: a
    // cache-invalidation failure shouldn't turn a successful publish into an
    // error response — the route will still serve fresh content on its next
    // natural revalidation.
    if (changedCollectionIds.size > 0) {
      try {
        const result = await invalidateForCollectionsChange([...changedCollectionIds]);
        if (result.invalidatedRoutes.length > 0) {
          console.log(`[Cache] item publish: invalidated ${result.invalidatedRoutes.length} route(s) across ${changedCollectionIds.size} collection(s)`);
        }
      } catch (cacheError) {
        console.error('[Cache] item publish: invalidation failed:', cacheError);
      }
    }

    // invalidateForCollectionsChange() above only calls revalidateTag/revalidatePath
    // (the Vercel/self-hosted path in invalidatePages()) — it does NOT call the
    // explicit Netlify REST-API purge (purgeNetlifyEdgeCache). That distinction
    // didn't matter while public pages were force-dynamic (nothing was ever
    // cached, so there was nothing to fail to invalidate), but now that they're
    // cacheable, relying on revalidateTag alone reproduces the exact "stale HTML
    // after publish on Netlify" failure mode that force-dynamic was originally
    // added to work around (see git history on app/(site)/page.tsx, 2026-03-31).
    // clearAllCache() calls the proven, explicit purgeNetlifyEdgeCache() REST/tag
    // purge unconditionally — broader than one collection's affected pages
    // (whole-tenant), which is an acceptable over-invalidation, not a
    // correctness risk. Non-fatal, same as above.
    if (changedCollectionIds.size > 0) {
      try {
        await clearAllCache(await resolveEffectiveTenantId());
      } catch (cacheError) {
        console.error('[Cache] item publish: clearAllCache failed:', cacheError);
      }

      // MASJIDWEB_SEAM: netlify-cache-warming — clearAllCache() above purged the
      // WHOLE tenant from the CDN (tag-scoped), so every page — not just the
      // ones rendering these collections — goes cold. Re-prime them all so the
      // next real visitor (usually the site owner checking their publish) gets
      // a cache hit instead of the full cold render. Must stay after the purge:
      // on Netlify warming runs inline, and warming first would bake the stale
      // copy back in.
      try {
        const warmResult = await warmRoutes(await getAllPublishedRoutes(), request);
        if (warmResult) {
          console.log(
            `[Cache] item publish: warmed ${warmResult.warmed}${warmResult.total > warmResult.warmed ? ` of ${warmResult.total}` : ''} route(s)`,
          );
        }
      } catch (warmError) {
        console.error('[Cache] item publish: warming failed:', warmError);
      }
      // MASJIDWEB_SEAM_END
    }
    // MASJIDWEB_SEAM_END

    return noCache({
      data: { count: publishedCount, skipped }
    });
  } catch (error) {
    console.error('Error publishing collection items:', error);
    return noCache(
      { error: error instanceof Error ? error.message : 'Failed to publish items' },
      500
    );
  }
}
