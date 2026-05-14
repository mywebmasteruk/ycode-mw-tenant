'use client';

import React, { useEffect, useMemo, useState, useCallback, useRef, startTransition, Suspense, lazy } from 'react';
import { Button } from '@/components/ui/button';
import Icon from '@/components/ui/icon';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';

// 4. Internal components
import LayersTree from './LayersTree';
import LeftSidebarPages, { type LeftSidebarPagesHandle } from './LeftSidebarPages';

// Lazy-loaded components (heavy, not needed immediately)
const ElementLibrary = lazy(() => import('./ElementLibrary'));

// 5. Stores
import { useEditorStore } from '@/stores/useEditorStore';
import { useComponentsStore } from '@/stores/useComponentsStore';
import { usePagesStore } from '@/stores/usePagesStore';

// 6. Utils
import { resetBindingsAfterMove } from '@/lib/layer-utils';

// 5.5 Hooks
import { useEditorUrl } from '@/hooks/use-editor-url';
import type { EditorTab } from '@/hooks/use-editor-url';
import { useLayerLocks } from '@/hooks/use-layer-locks';
import { useResizableSidebar } from '@/hooks/use-resizable-sidebar';

// 6. Types
import type { Layer } from '@/types';
import { Empty, EmptyDescription, EmptyTitle } from '@/components/ui/empty';

import type { UseLiveLayerUpdatesReturn } from '@/hooks/use-live-layer-updates';
import type { UseLiveComponentUpdatesReturn } from '@/hooks/use-live-component-updates';

interface LeftSidebarProps {
  selectedLayerId: string | null;
  selectedLayerIds?: string[]; // New multi-select support
  onLayerSelect: (layerId: string | null) => void;
  currentPageId: string | null;
  onPageSelect: (pageId: string) => void;
  liveLayerUpdates?: UseLiveLayerUpdatesReturn | null;
  liveComponentUpdates?: UseLiveComponentUpdatesReturn | null;
}

const LeftSidebar = React.memo(function LeftSidebar({
  selectedLayerId,
  selectedLayerIds,
  onLayerSelect,
  currentPageId,
  onPageSelect,
  liveLayerUpdates,
  liveComponentUpdates,
}: LeftSidebarProps) {
  const { sidebarTab } = useEditorUrl();
  const [showElementLibrary, setShowElementLibrary] = useState(false);
  const { width: sidebarWidth, isDragging: isResizing, handleMouseDown: handleResizeMouseDown } = useResizableSidebar({ side: 'left' });
  const pagesRef = useRef<LeftSidebarPagesHandle>(null);
  const [assetMessage, setAssetMessage] = useState<string | null>(null);

  // Optimize store subscriptions - scoped to current page only
  const currentDraft = usePagesStore((state) => currentPageId ? state.draftsByPageId[currentPageId] : null);
  const loadFolders = usePagesStore((state) => state.loadFolders);
  const loadDraft = usePagesStore((state) => state.loadDraft);
  const deletePage = usePagesStore((state) => state.deletePage);
  const updateLayer = usePagesStore((state) => state.updateLayer);
  const setDraftLayers = usePagesStore((state) => state.setDraftLayers);
  const pages = usePagesStore((state) => state.pages);
  const folders = usePagesStore((state) => state.folders);

  const setCurrentPageId = useEditorStore((state) => state.setCurrentPageId);
  const editingComponentId = useEditorStore((state) => state.editingComponentId);
  const setActiveSidebarTab = useEditorStore((state) => state.setActiveSidebarTab);

  const storeSidebarTab = useEditorStore((state) => state.activeSidebarTab);

  // Sync URL → store only on initial mount
  const hasInitializedTabRef = useRef(false);
  useEffect(() => {
    if (!hasInitializedTabRef.current) {
      hasInitializedTabRef.current = true;
      setActiveSidebarTab(sidebarTab);
    }
  }, [sidebarTab, setActiveSidebarTab]);

  const activeTab = storeSidebarTab || sidebarTab;

  const componentDrafts = useComponentsStore((state) => state.componentDrafts);
  const getComponentById = useComponentsStore((state) => state.getComponentById);
  const updateComponentDraft = useComponentsStore((state) => state.updateComponentDraft);

  // Collaboration hooks - re-enabled
  const layerLocks = useLayerLocks();
  // Store in ref to avoid dependency changes triggering infinite loops
  const layerLocksRef = useRef(layerLocks);
  layerLocksRef.current = layerLocks;

  // Get component layers if in edit mode
  const editingComponent = editingComponentId ? getComponentById(editingComponentId) : null;

  // Listen for keyboard shortcut to toggle ElementLibrary
  useEffect(() => {
    const handleToggleElementLibrary = (event: Event) => {
      const customEvent = event as CustomEvent<{ tab?: 'elements' | 'layouts' | 'components' }>;
      const tab = customEvent.detail?.tab;

      if (tab) {
        setShowElementLibrary(true);
        setActiveSidebarTab('layers');
      } else {
        setShowElementLibrary((prev) => !prev);
      }
    };

    window.addEventListener('toggleElementLibrary', handleToggleElementLibrary);
    return () => window.removeEventListener('toggleElementLibrary', handleToggleElementLibrary);
  }, []);

  // Listen for close ElementLibrary event (e.g., when clicking on canvas)
  useEffect(() => {
    const handleCloseElementLibrary = () => {
      setShowElementLibrary(false);
    };

    window.addEventListener('closeElementLibrary', handleCloseElementLibrary);
    return () => window.removeEventListener('closeElementLibrary', handleCloseElementLibrary);
  }, []);

  // Lock-aware layer selection handler
  const handleLayerSelect = useCallback((layerId: string) => {
    // Check if layer is locked by another user
    const locks = layerLocksRef.current;
    const isLocked = locks.isLayerLocked(layerId);
    const canEdit = locks.canEditLayer(layerId);

    if (isLocked && !canEdit) {
      console.warn(`Layer ${layerId} is locked by another user - cannot select`);
      return;
    }

    // Call the original onLayerSelect if not locked
    onLayerSelect(layerId);
  }, [onLayerSelect]);

  const layersForCurrentPage = useMemo(() => {
    // If editing a component, show component layers instead
    if (editingComponentId) {
      return componentDrafts[editingComponentId] || [];
    }

    // Otherwise show page layers
    if (!currentPageId) return [];
    return currentDraft ? currentDraft.layers : [];
  }, [editingComponentId, componentDrafts, currentPageId, currentDraft]);

  // Handle layer reordering from drag & drop
  const handleLayersReorder = useCallback((newLayers: Layer[], movedLayerId?: string) => {
    // Reset invalid CMS bindings if a layer was moved to a different parent
    let layers = newLayers;
    if (movedLayerId) {
      layers = resetBindingsAfterMove(layers, movedLayerId);
    }

    // If editing component, update component draft
    if (editingComponentId) {
      updateComponentDraft(editingComponentId, layers);
      return;
    }

    // Otherwise update page draft
    if (!currentPageId) return;
    setDraftLayers(currentPageId, layers);
  }, [editingComponentId, updateComponentDraft, currentPageId, setDraftLayers]);

  // Helper to find layer in tree
  const findLayer = useCallback((layers: Layer[], id: string): { layer: Layer; parentId: string | null } | null => {
    for (const layer of layers) {
      if (layer.id === id) {
        return { layer, parentId: null };
      }
      if (layer.children) {
        const found = findLayer(layer.children, id);
        if (found) {
          return { ...found, parentId: found.parentId || layer.id };
        }
      }
    }
    return null;
  }, []);

  // Load draft when page changes (only if not already in store)
  // Wrapped in startTransition so draft loading doesn't block UI updates
  useEffect(() => {
    if (currentPageId && !currentDraft) {
      startTransition(() => {
        loadDraft(currentPageId);
      });
    }
  }, [currentPageId, loadDraft, currentDraft]);

  // Preload adjacent page drafts in background for instant navigation
  // Uses requestIdleCallback to avoid blocking the main thread
  useEffect(() => {
    if (!currentPageId || pages.length === 0) return;

    // Find current page index
    const currentIndex = pages.findIndex(p => p.id === currentPageId);
    if (currentIndex === -1) return;

    // Get adjacent pages (2 before, 2 after)
    const adjacentPages = pages.slice(
      Math.max(0, currentIndex - 2),
      Math.min(pages.length, currentIndex + 3)
    ).filter(p => p.id !== currentPageId);

    // Use requestIdleCallback for low-priority background loading
    const preloadDrafts = () => {
      const allDrafts = usePagesStore.getState().draftsByPageId;
      const pagesToPreload = adjacentPages.filter(p => !allDrafts[p.id]);
      pagesToPreload.forEach((page, index) => {
        setTimeout(() => {
          if (!usePagesStore.getState().draftsByPageId[page.id]) {
            loadDraft(page.id);
          }
        }, index * 100);
      });
    };

    if ('requestIdleCallback' in window) {
      const idleCallbackId = requestIdleCallback(preloadDrafts, { timeout: 2000 });
      return () => cancelIdleCallback(idleCallbackId);
    } else {
      const timeoutId = setTimeout(preloadDrafts, 500);
      return () => clearTimeout(timeoutId);
    }
  }, [currentPageId, pages, loadDraft]);

  // Handle asset selection
  const handleAssetSelect = (asset: { id: string; public_url: string; filename: string }) => {
    if (!currentPageId) {
      setAssetMessage('❌ Please select a page first');
      setTimeout(() => setAssetMessage(null), 3000);
      return;
    }

    if (!selectedLayerId) {
      setAssetMessage('❌ Please select an image layer first');
      setTimeout(() => setAssetMessage(null), 3000);
      return;
    }

    // Find the selected layer
    const selectedItem = findLayer(layersForCurrentPage, selectedLayerId);

    if (!selectedItem) {
      setAssetMessage('❌ Layer not found');
      setTimeout(() => setAssetMessage(null), 3000);
      return;
    }

    // Check if it's an image layer
    if (selectedItem.layer.name !== 'image') {
      setAssetMessage('❌ Please select an image layer (not a container, text, or heading)');
      setTimeout(() => setAssetMessage(null), 3000);
      return;
    }

    // Update the layer's image src
    updateLayer(currentPageId, selectedLayerId, {
      variables: {
        image: {
          src: {
            type: 'asset',
            data: { asset_id: asset.id }
          },
          alt: {
            type: 'dynamic_text',
            data: { content: asset.filename }
          }
        }
      }
    });

    setAssetMessage(`✅ Image set: ${asset.filename}`);
    setTimeout(() => setAssetMessage(null), 3000);
  };

  return (
    <>
      <div
        className="shrink-0 relative"
        style={{ width: `${sidebarWidth}px` }}
      >
      <div
        className="w-full h-full bg-background border-r flex overflow-hidden p-4 pb-0"
      >
        {/* Tabs */}
        <div className="w-full">
          <Tabs
            value={activeTab}
            onValueChange={async (value) => {
              const newTab = value as EditorTab;

              if (newTab === 'layers' && pagesRef.current) {
                const canSwitch = await pagesRef.current.checkAndCloseSettings();
                if (!canSwitch) return;
              }

              setActiveSidebarTab(newTab);
              setShowElementLibrary(false);

              // Update URL without triggering Next.js navigation to avoid re-renders
              const targetPageId = currentPageId || (pages.length > 0 ? pages[0].id : null);
              if (targetPageId) {
                const segment = newTab === 'layers' ? 'layers' : 'pages';
                const newPath = `/ycode/${segment}/${targetPageId}${window.location.search}`;
                window.history.replaceState(null, '', newPath);
              }
            }}
            className="h-full overflow-hidden gap-0!"
          >
            <TabsList className="w-full shrink-0">
              <TabsTrigger value="layers">Layers</TabsTrigger>
              <TabsTrigger value="pages">Pages</TabsTrigger>
            </TabsList>

            <hr className="mt-4" />

            {/* Content - forceMount keeps all tabs mounted for instant switching */}
            <TabsContent
              value="layers" className="flex flex-col min-h-0"
              forceMount
            >
              <header className="py-5 flex justify-between shrink-0 z-20">
                <span className="font-medium">{editingComponentId ? 'Layers' : 'Layers'}</span>
                <div className="-my-1">
                  <Button
                    size="xs" variant="secondary"
                    onClick={() => setShowElementLibrary(prev => !prev)}
                  >
                    <Icon name="plus" className={`${showElementLibrary ? 'rotate-45' : 'rotate-0'} transition-transform duration-100`} />
                  </Button>
                </div>
              </header>

              <div
                className="flex flex-col flex-1 min-h-0 overflow-y-auto overflow-x-auto no-scrollbar"
                style={{ '--tree-available-width': `${sidebarWidth - 33}px` } as React.CSSProperties}
              >
                {!currentPageId && !editingComponentId ? (
                  <Empty>
                    <EmptyTitle>No page selected</EmptyTitle>
                    <EmptyDescription>Select a page from the Pages tab to start building</EmptyDescription>
                  </Empty>
                ) : layersForCurrentPage.length === 0 ? (
                  <Empty>
                    <EmptyTitle>No layers yet</EmptyTitle>
                    <EmptyDescription>Click the + button above to add your first block</EmptyDescription>
                  </Empty>
                ) : (
                  <LayersTree
                    layers={layersForCurrentPage}
                    selectedLayerId={selectedLayerId}
                    selectedLayerIds={selectedLayerIds}
                    onLayerSelect={handleLayerSelect}
                    onReorder={handleLayersReorder}
                    pageId={currentPageId || ''}
                    liveLayerUpdates={liveLayerUpdates}
                    liveComponentUpdates={liveComponentUpdates}
                  />
                )}
              </div>
            </TabsContent>

            <TabsContent
              value="pages"
              className="flex flex-col min-h-0 overflow-y-auto no-scrollbar"
              forceMount
            >
              <LeftSidebarPages
                ref={pagesRef}
                pages={pages}
                folders={folders}
                currentPageId={currentPageId}
                onPageSelect={onPageSelect}
                setCurrentPageId={setCurrentPageId}
              />
            </TabsContent>

          </Tabs>
        </div>

      </div>

      {/* Resize handle - wide hit area, thin visible line on hover */}
      <div
        onMouseDown={handleResizeMouseDown}
        className="absolute top-0 -right-1.5 w-3 h-full cursor-col-resize z-30 flex items-center justify-center group/resize"
      >
        <div className="w-0.5 h-full bg-transparent group-hover/resize:bg-primary/50 group-active/resize:bg-primary/70 transition-colors" />
      </div>
      </div>

      {/* Invisible overlay during resize to prevent iframe from capturing mouse events */}
      {isResizing && (
        <div className="fixed inset-0 z-50 cursor-col-resize" />
      )}

      {/* Element Library Slide-Out (lazy loaded, always mounted to preserve state) */}
      <Suspense fallback={null}>
        <ElementLibrary
          isOpen={showElementLibrary}
          onClose={() => setShowElementLibrary(false)}
          liveLayerUpdates={liveLayerUpdates}
        />
      </Suspense>
    </>
  );
});

export default LeftSidebar;
