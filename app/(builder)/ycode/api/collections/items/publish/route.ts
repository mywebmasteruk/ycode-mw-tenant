import { NextRequest, NextResponse } from 'next/server';
import { publishValues } from '@/lib/repositories/collectionItemValueRepository';
import { hardDeleteItem, getItemById } from '@/lib/repositories/collectionItemRepository';
import { getCollectionById } from '@/lib/repositories/collectionRepository';
import { cleanupDeletedCollections } from '@/lib/services/collectionService';
import { invalidateForCollectionChange, clearAllCache } from '@/lib/services/cacheService';
import { resolveEffectiveTenantId } from '@/lib/masjidweb/effective-tenant-id';
import { noCache } from '@/lib/api-response';

// Disable caching for this route
export const dynamic = 'force-dynamic';
export const revalidate = 0;

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
    // Collections actually touched by a successful publish/delete below — the
    // v1 API's equivalent routes invalidate cache after every item write
    // (see app/(builder)/ycode/api/v1/collections/[collection_id]/items/[item_id]/route.ts),
    // but this builder-facing route never did, so the public page kept
    // serving stale content indefinitely after a normal "edit item, publish"
    // in the CMS UI — even once the underlying write itself succeeded.
    const changedCollectionIds = new Set<string>();

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
          changedCollectionIds.add(item.collection_id);
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
          changedCollectionIds.add(item.collection_id);
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

    // Invalidate cached routes for every page that renders one of the
    // collections we touched. Non-fatal: a cache-invalidation failure
    // shouldn't turn a successful publish into an error response — the
    // route will still serve fresh content on its next natural revalidation.
    for (const collectionId of changedCollectionIds) {
      try {
        const result = await invalidateForCollectionChange(collectionId);
        if (result.invalidatedRoutes.length > 0) {
          console.log(`[Cache] item publish: invalidated ${result.invalidatedRoutes.length} route(s) for collection ${collectionId}`);
        }
      } catch (cacheError) {
        console.error(`[Cache] item publish: invalidation failed for collection ${collectionId}:`, cacheError);
      }
    }

    // invalidateForCollectionChange() above only calls revalidateTag/revalidatePath
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
    }

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
