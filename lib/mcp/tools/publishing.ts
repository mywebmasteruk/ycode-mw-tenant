import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { getUnpublishedPages, getAllDraftPages } from '@/lib/repositories/pageRepository';
import { getUnpublishedLayerStyles, publishLayerStyles } from '@/lib/repositories/layerStyleRepository';
import { getUnpublishedComponents, publishComponents } from '@/lib/repositories/componentRepository';
import { getAllCollections, getUnpublishedCollections } from '@/lib/repositories/collectionRepository';
import { getItemsByCollectionId } from '@/lib/repositories/collectionItemRepository';
import { getUnpublishedAssets, publishAssets, hardDeleteSoftDeletedAssets } from '@/lib/repositories/assetRepository';
import { getUnpublishedAssetFolders, publishAssetFolders, hardDeleteSoftDeletedAssetFolders } from '@/lib/repositories/assetFolderRepository';
import { getUnpublishedFonts, publishFonts } from '@/lib/repositories/fontRepository';
import { publishPages } from '@/lib/services/pageService';
import { publishCollectionWithItems } from '@/lib/services/collectionService';
import { publishLocalisation } from '@/lib/services/localisationService';
import { publishFolders } from '@/lib/services/folderService';
import { publishCSS, savePublishedAt } from '@/lib/services/settingsService';
import { generateAndSaveDraftCSS } from '@/lib/server/cssGenerator';
import { resolveEffectiveTenantId } from '@/lib/masjidweb/effective-tenant-id';
import { clearAllCache } from '@/lib/services/cacheService';

export function registerPublishingTools(server: McpServer) {
  server.tool(
    'get_unpublished_changes',
    'Check what changes are pending and need to be published. Reports unpublished pages, styles, components, collections, fonts, and assets.',
    {},
    async () => {
      const [pages, styles, components, collections, fonts, assets, assetFolders] = await Promise.all([
        getUnpublishedPages().catch(() => []),
        getUnpublishedLayerStyles().catch(() => []),
        getUnpublishedComponents().catch(() => []),
        getUnpublishedCollections().catch(() => []),
        getUnpublishedFonts().catch(() => []),
        getUnpublishedAssets().catch(() => []),
        getUnpublishedAssetFolders().catch(() => []),
      ]);

      const hasChanges = pages.length > 0 || styles.length > 0 || components.length > 0
        || collections.length > 0 || fonts.length > 0 || assets.length > 0 || assetFolders.length > 0;

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            has_unpublished_changes: hasChanges,
            unpublished_pages: pages.map((p) => ({ id: p.id, name: p.name })),
            unpublished_styles: styles.map((s) => ({ id: s.id, name: s.name })),
            unpublished_components: components.map((c: { id: string; name: string }) => ({ id: c.id, name: c.name })),
            unpublished_collections: collections.map((c: { id: string; name: string }) => ({ id: c.id, name: c.name })),
            unpublished_fonts: fonts.map((f) => ({ id: f.id, family: f.family })),
            unpublished_assets: assets.length,
            unpublished_asset_folders: assetFolders.length,
          }, null, 2),
        }],
      };
    },
  );

  server.tool(
    'publish',
    'Publish all draft changes to make them live. This publishes pages, collections, components, styles, assets, and regenerates CSS.',
    {},
    async () => {
      const publishedAt = new Date().toISOString();
      const changes: Record<string, number> = {};

      const failed: string[] = [];

      // Publish folders
      try {
        const foldersResult = await publishFolders([], undefined);
        changes.folders = foldersResult.count;
      } catch (e) { changes.folders = 0; failed.push('folders'); console.error('[publish] folders failed:', e); }

      // Publish all draft pages
      try {
        const draftPages = await getAllDraftPages();
        if (draftPages.length > 0) {
          const result = await publishPages(draftPages.map((p) => p.id));
          changes.pages = result.count;
        } else {
          changes.pages = 0;
        }
      } catch (e) { changes.pages = 0; failed.push('pages'); console.error('[publish] pages failed:', e); }

      // Publish collections with items
      try {
        const allCollections = await getAllCollections({ is_published: false });
        let totalItems = 0;
        for (const collection of allCollections) {
          const { items } = await getItemsByCollectionId(collection.id, false);
          if (items.length > 0) {
            const result = await publishCollectionWithItems({
              collectionId: collection.id,
              itemIds: items.map((item: { id: string }) => item.id),
            });
            totalItems += result.published?.itemsCount || 0;
          }
        }
        changes.collection_items = totalItems;
      } catch (e) { changes.collection_items = 0; failed.push('collections'); console.error('[publish] collections failed:', e); }

      // Publish components
      try {
        const unpublished = await getUnpublishedComponents();
        if (unpublished.length > 0) {
          const result = await publishComponents(unpublished.map((c: { id: string }) => c.id));
          changes.components = result.count;
        } else {
          changes.components = 0;
        }
      } catch (e) { changes.components = 0; failed.push('components'); console.error('[publish] components failed:', e); }

      // Publish layer styles
      try {
        const unpublished = await getUnpublishedLayerStyles();
        if (unpublished.length > 0) {
          const result = await publishLayerStyles(unpublished.map((s) => s.id));
          changes.layer_styles = result.count;
        } else {
          changes.layer_styles = 0;
        }
      } catch (e) { changes.layer_styles = 0; failed.push('layer_styles'); console.error('[publish] layer_styles failed:', e); }

      // Publish asset folders
      try {
        await hardDeleteSoftDeletedAssetFolders();
        const unpublished = await getUnpublishedAssetFolders();
        if (unpublished.length > 0) {
          const result = await publishAssetFolders(unpublished.map((f: { id: string }) => f.id));
          changes.asset_folders = result.count;
        }
      } catch (e) { failed.push('asset_folders'); console.error('[publish] asset_folders failed:', e); }

      // Publish assets
      try {
        await hardDeleteSoftDeletedAssets();
        const unpublished = await getUnpublishedAssets();
        if (unpublished.length > 0) {
          const result = await publishAssets(unpublished.map((a: { id: string }) => a.id));
          changes.assets = result.count;
        }
      } catch (e) { failed.push('assets'); console.error('[publish] assets failed:', e); }

      // Publish fonts
      try { await publishFonts(); } catch (e) { failed.push('fonts'); console.error('[publish] fonts failed:', e); }

      // Publish locales and translations
      try {
        const locResult = await publishLocalisation();
        changes.locales = locResult.locales;
        changes.translations = locResult.translations;
      } catch (e) { failed.push('localisation'); console.error('[publish] localisation failed:', e); }

      // Regenerate draft CSS from all current layers, then publish it
      try {
        await generateAndSaveDraftCSS();
        await publishCSS();
      } catch (e) { failed.push('css'); console.error('[publish] CSS failed:', e); }

      // Clear cache. No warming here: MCP is invoked over JSON-RPC, not HTTP,
      // so there's no Request/host header to build absolute URLs from. The
      // builder's HTTP publish endpoint warms after publish — this AI tool
      // path is rare enough that a cold next-visit is acceptable.
      try {
        await clearAllCache(await resolveEffectiveTenantId());
      } catch { /* non-fatal */ }

      // Save published_at timestamp
      try { await savePublishedAt(publishedAt); } catch (e) { failed.push('published_at'); console.error('[publish] published_at failed:', e); }

      const total = Object.values(changes).reduce((sum, n) => sum + n, 0);

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            success: failed.length === 0,
            message: failed.length === 0
              ? `Published ${total} item(s) successfully`
              : `Published ${total} item(s) with ${failed.length} step(s) failing: ${failed.join(', ')}`,
            published_at: publishedAt,
            changes,
            ...(failed.length > 0 ? { failed_steps: failed } : {}),
          }, null, 2),
        }],
      };
    },
  );
}
