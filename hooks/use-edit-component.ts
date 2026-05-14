'use client';

/**
 * useEditComponent
 *
 * Returns a callback that opens a component in the editor, handling:
 * - Pushing the current page or parent component onto the navigation stack
 * - Loading the component's draft
 * - Navigating to the component edit URL
 * - Restoring the user's selection inside the component
 *
 * Used by both `ComponentInstanceSidebar` (Edit component button) and
 * `CenterCanvas` (double-click on a component instance on the canvas).
 */

import { useCallback } from 'react';

import { useEditorActions } from '@/hooks/use-editor-url';
import { useComponentsStore } from '@/stores/useComponentsStore';
import { useEditorStore } from '@/stores/useEditorStore';
import { usePagesStore } from '@/stores/usePagesStore';
import { findLayerById } from '@/lib/layer-utils';

export interface EditComponentOptions {
  /**
   * Layer to restore on exit (typically the component instance layer that was
   * interacted with on the page or in a parent component).
   */
  returnToLayerId?: string;
  /**
   * Layer inside the component to select after entering edit mode.
   * Defaults to the first child layer of the component.
   */
  initialSelectionLayerId?: string;
}

export function useEditComponent(): (componentId: string, options?: EditComponentOptions) => Promise<void> {
  const { openComponent } = useEditorActions();

  return useCallback(async (componentId: string, options: EditComponentOptions = {}) => {
    const { returnToLayerId, initialSelectionLayerId } = options;

    const { loadComponentDraft, getComponentById } = useComponentsStore.getState();
    const {
      currentPageId,
      editingComponentId,
      setSelectedLayerId,
      pushComponentNavigation,
    } = useEditorStore.getState();
    const { pages } = usePagesStore.getState();

    const component = getComponentById(componentId);
    if (!component) return;

    setSelectedLayerId(null);

    if (editingComponentId) {
      const currentComponent = getComponentById(editingComponentId);
      if (currentComponent) {
        pushComponentNavigation({
          type: 'component',
          id: editingComponentId,
          name: currentComponent.name,
          layerId: returnToLayerId ?? null,
        });
      }
    } else if (currentPageId) {
      const currentPage = pages.find((p) => p.id === currentPageId);
      if (currentPage) {
        pushComponentNavigation({
          type: 'page',
          id: currentPageId,
          name: currentPage.name,
          layerId: returnToLayerId ?? null,
        });
      }
    }

    await loadComponentDraft(componentId);
    openComponent(componentId, currentPageId, undefined, returnToLayerId);

    // Select an initial layer inside the component if the user hasn't
    // already selected something valid during the await.
    if (component.layers && component.layers.length > 0) {
      const currentSelection = useEditorStore.getState().selectedLayerId;
      const hasValidSelection = currentSelection && findLayerById(component.layers, currentSelection);
      if (!hasValidSelection) {
        const target = initialSelectionLayerId
          && findLayerById(component.layers, initialSelectionLayerId)
          ? initialSelectionLayerId
          : component.layers[0].id;
        setSelectedLayerId(target);
      }
    }
  }, [openComponent]);
}
