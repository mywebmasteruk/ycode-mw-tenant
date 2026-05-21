import { create } from 'zustand';
import { collectionsApi } from '@/lib/api';
import { MULTI_ASSET_COLLECTION_ID } from '@/lib/collection-field-utils';
import type { CollectionItemWithValues, CollectionPaginationMeta } from '@/types';

/**
 * Collection Layer Store
 *
 * Manages collection data specifically for collection layers in the builder.
 * This is separate from the CMS items store to allow independent data fetching
 * with different sort/limit/offset settings per layer.
 */

interface CollectionLayerState {
  layerData: Record<string, CollectionItemWithValues[]>; // keyed by layerId
  loading: Record<string, boolean>; // loading state per layer
  error: Record<string, string | null>; // error state per layer
  layerConfig: Record<string, { collectionId: string; sortBy?: string; sortOrder?: 'asc' | 'desc'; limit?: number; offset?: number; filters?: Array<{ fieldId: string; operator: string; value: string }> }>; // Track config per layer
  referencedItems: Record<string, CollectionItemWithValues[]>; // Items for referenced collections, keyed by collectionId
  referencedLoading: Record<string, boolean>; // Loading state for referenced collections
  // Pagination state
  paginationMeta: Record<string, CollectionPaginationMeta>; // Pagination meta per layer
  paginationLoading: Record<string, boolean>; // Loading state for pagination per layer
  // Bumped after CMS updates to signal the canvas should re-fetch
  invalidationKey: number;
}

interface CollectionLayerActions {
  fetchLayerData: (
    layerId: string,
    collectionId: string,
    sortBy?: string,
    sortOrder?: 'asc' | 'desc',
    limit?: number,
    offset?: number,
    filters?: Array<{ fieldId: string; operator: string; value: string }>
  ) => Promise<void>;
  fetchReferencedCollectionItems: (collectionId: string) => Promise<void>;
  fetchReferencedCollectionsBatch: (collectionIds: string[]) => Promise<void>;
  clearLayerData: (layerId: string) => void;
  clearAllLayerData: () => void;
  updateItemInLayerData: (itemId: string, values: Record<string, string>) => void;
  invalidateLayerData: (collectionId: string) => void;
  refetchLayersForCollection: (collectionId: string) => Promise<void>;
  // Pagination actions
  fetchPage: (layerId: string, page: number) => Promise<{ items: CollectionItemWithValues[]; meta: CollectionPaginationMeta } | null>;
  setPaginationMeta: (layerId: string, meta: CollectionPaginationMeta) => void;
}

type CollectionLayerStore = CollectionLayerState & CollectionLayerActions;

export const useCollectionLayerStore = create<CollectionLayerStore>((set, get) => ({
  // Initial state
  layerData: {},
  loading: {},
  error: {},
  layerConfig: {},
  referencedItems: {},
  referencedLoading: {},
  paginationMeta: {},
  paginationLoading: {},
  invalidationKey: 0,

  // Fetch items for a referenced collection (used for reference field resolution)
  fetchReferencedCollectionItems: async (collectionId: string) => {
    const { referencedItems, referencedLoading } = get();

    // Skip if already loaded or loading
    if (referencedItems[collectionId] || referencedLoading[collectionId]) {
      return;
    }

    set((state) => ({
      referencedLoading: { ...state.referencedLoading, [collectionId]: true },
    }));

    try {
      const response = await collectionsApi.getItems(collectionId, { limit: 100 });

      if (!response.error && response.data?.items) {
        set((state) => ({
          referencedItems: { ...state.referencedItems, [collectionId]: response.data!.items },
          referencedLoading: { ...state.referencedLoading, [collectionId]: false },
        }));
      }
    } catch (error) {
      console.error(`[CollectionLayerStore] Error fetching referenced items for ${collectionId}:`, error);
      set((state) => ({
        referencedLoading: { ...state.referencedLoading, [collectionId]: false },
      }));
    }
  },

  /**
   * Fetch reference-display items for many collections in a single round-trip.
   * Dedupes against already-loaded/in-flight collections so it's safe to call
   * with the full set of referenced IDs on every canvas re-render.
   */
  fetchReferencedCollectionsBatch: async (collectionIds: string[]) => {
    const { referencedItems, referencedLoading } = get();

    const toFetch = collectionIds.filter(
      (id) => !referencedItems[id] && !referencedLoading[id],
    );
    if (toFetch.length === 0) return;

    set((state) => {
      const nextLoading = { ...state.referencedLoading };
      for (const id of toFetch) nextLoading[id] = true;
      return { referencedLoading: nextLoading };
    });

    try {
      const response = await collectionsApi.getReferencedItemsBatch(toFetch, 100);

      if (response.error || !response.data?.items) {
        throw new Error(response.error || 'Empty batch reference response');
      }

      const batchItems = response.data.items;
      set((state) => {
        const nextReferenced = { ...state.referencedItems };
        const nextLoading = { ...state.referencedLoading };
        for (const id of toFetch) {
          nextReferenced[id] = batchItems[id]?.items || [];
          nextLoading[id] = false;
        }
        return { referencedItems: nextReferenced, referencedLoading: nextLoading };
      });
    } catch (error) {
      console.error('[CollectionLayerStore] Error fetching referenced items batch:', error);
      set((state) => {
        const nextLoading = { ...state.referencedLoading };
        for (const id of toFetch) nextLoading[id] = false;
        return { referencedLoading: nextLoading };
      });
    }
  },

  // Fetch data for a specific layer
  fetchLayerData: async (
    layerId: string,
    collectionId: string,
    sortBy?: string,
    sortOrder: 'asc' | 'desc' = 'asc',
    limit?: number,
    offset?: number,
    filters?: Array<{ fieldId: string; operator: string; value: string }>
  ) => {
    const { loading, layerConfig } = get();

    // Skip for virtual collections (multi-asset)
    if (collectionId === MULTI_ASSET_COLLECTION_ID) {
      return;
    }

    // Skip if already loading
    if (loading[layerId]) {
      return;
    }

    // Check if we already fetched with the same config.
    // `layerConfig[layerId]` is only set after a successful fetch, so its presence
    // signals "already fetched" regardless of whether the result was empty.
    const existingConfig = layerConfig[layerId];
    const filtersMatch = JSON.stringify(existingConfig?.filters) === JSON.stringify(filters);
    const configMatches = existingConfig &&
      existingConfig.collectionId === collectionId &&
      existingConfig.sortBy === sortBy &&
      existingConfig.sortOrder === sortOrder &&
      existingConfig.limit === limit &&
      existingConfig.offset === offset &&
      filtersMatch;

    // Skip if config matches — prevents refetching when a collection legitimately
    // returns an empty array (otherwise the layer would loop fetching forever).
    if (configMatches) {
      return;
    }

    // Set loading state
    set((state) => ({
      loading: { ...state.loading, [layerId]: true },
      error: { ...state.error, [layerId]: null },
    }));

    try {
      // Fetch items using existing API with layer-specific parameters
      const response = await collectionsApi.getItems(collectionId, {
        sortBy,
        sortOrder,
        limit,
        offset,
        filters,
      });

      if (response.error) {
        throw new Error(response.error);
      }

      const items = response.data?.items || [];

      // Store fetched data keyed by layerId
      set((state) => ({
        layerData: { ...state.layerData, [layerId]: items },
        loading: { ...state.loading, [layerId]: false },
        layerConfig: {
          ...state.layerConfig,
          [layerId]: { collectionId, sortBy, sortOrder, limit, offset, filters }
        },
      }));
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Failed to fetch layer data';
      set((state) => ({
        error: { ...state.error, [layerId]: errorMessage },
        loading: { ...state.loading, [layerId]: false },
      }));
      console.error(`[CollectionLayerStore] Error fetching data for layer ${layerId}:`, error);
    }
  },

  // Clear data for a specific layer
  clearLayerData: (layerId: string) => {
    set((state) => {
      const { [layerId]: _, ...restLayerData } = state.layerData;
      const { [layerId]: __, ...restLoading } = state.loading;
      const { [layerId]: ___, ...restError } = state.error;

      return {
        layerData: restLayerData,
        loading: restLoading,
        error: restError,
      };
    });
  },

  // Clear all layer data
  clearAllLayerData: () => {
    set({
      layerData: {},
      loading: {},
      error: {},
      referencedItems: {},
      referencedLoading: {},
    });
  },

  // Optimistically update an item across all layer data
  updateItemInLayerData: (itemId, values) => {
    set((state) => {
      const newLayerData = { ...state.layerData };

      // Update the item in all layers that have it
      Object.keys(newLayerData).forEach(layerId => {
        newLayerData[layerId] = newLayerData[layerId].map(item => {
          if (item.id === itemId) {
            return { ...item, values };
          }
          return item;
        });
      });

      return { layerData: newLayerData };
    });
  },

  // Invalidate cached layer data for a specific collection so the next fetchLayerData call bypasses the config-match check.
  // Also clears referenced items cache since reference fields may point to this collection.
  invalidateLayerData: (collectionId: string) => {
    const { layerConfig, referencedItems } = get();
    const updatedConfig = { ...layerConfig };
    for (const [layerId, config] of Object.entries(updatedConfig)) {
      if (config.collectionId === collectionId) {
        delete updatedConfig[layerId];
      }
    }
    const updatedReferenced = { ...referencedItems };
    delete updatedReferenced[collectionId];
    set({
      layerConfig: updatedConfig,
      referencedItems: updatedReferenced,
      invalidationKey: get().invalidationKey + 1,
    });
  },

  // Refetch all layers that use a specific collection
  refetchLayersForCollection: async (collectionId) => {
    const { layerConfig } = get();

    // Find all layers that use this collection
    const layersToRefetch = Object.entries(layerConfig)
      .filter(([_, config]) => config.collectionId === collectionId)
      .map(([layerId]) => layerId);

    // Refetch each layer without showing loading state
    for (const layerId of layersToRefetch) {
      const config = layerConfig[layerId];
      if (config) {
        try {
          const response = await collectionsApi.getItems(config.collectionId, {
            sortBy: config.sortBy,
            sortOrder: config.sortOrder,
            limit: config.limit,
            offset: config.offset,
            filters: config.filters,
          });

          if (!response.error && response.data?.items) {
            // Update data silently (no loading state change)
            set((state) => ({
              layerData: { ...state.layerData, [layerId]: response.data!.items },
            }));
          }
        } catch (error) {
          console.error(`[CollectionLayerStore] Error refetching layer ${layerId}:`, error);
        }
      }
    }
  },

  // Set pagination meta for a layer
  setPaginationMeta: (layerId, meta) => {
    set((state) => ({
      paginationMeta: { ...state.paginationMeta, [layerId]: meta },
    }));
  },

  // Fetch a specific page for a layer with pagination
  fetchPage: async (layerId, page) => {
    const { paginationMeta, layerConfig } = get();
    const meta = paginationMeta[layerId];
    const config = layerConfig[layerId];

    if (!meta || !config) {
      console.warn(`[CollectionLayerStore] Cannot fetch page for layer ${layerId}: missing meta or config`);
      return null;
    }

    // Set loading state
    set((state) => ({
      paginationLoading: { ...state.paginationLoading, [layerId]: true },
    }));

    try {
      const offset = (page - 1) * meta.itemsPerPage;

      const response = await collectionsApi.getItems(config.collectionId, {
        sortBy: config.sortBy,
        sortOrder: config.sortOrder,
        limit: meta.itemsPerPage,
        offset,
      });

      if (response.error) {
        throw new Error(response.error);
      }

      const items = response.data?.items || [];
      const total = response.data?.total || 0;

      // Build new pagination meta
      const newMeta: CollectionPaginationMeta = {
        ...meta,
        currentPage: page,
        totalItems: total,
        totalPages: Math.ceil(total / meta.itemsPerPage),
      };

      // Update store
      set((state) => ({
        layerData: { ...state.layerData, [layerId]: items },
        paginationMeta: { ...state.paginationMeta, [layerId]: newMeta },
        paginationLoading: { ...state.paginationLoading, [layerId]: false },
      }));

      return { items, meta: newMeta };
    } catch (error) {
      console.error(`[CollectionLayerStore] Error fetching page for layer ${layerId}:`, error);
      set((state) => ({
        paginationLoading: { ...state.paginationLoading, [layerId]: false },
      }));
      return null;
    }
  },
}));
