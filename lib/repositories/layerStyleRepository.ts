/**
 * Layer Style Repository
 *
 * Data access layer for layer styles (reusable design configurations)
 * Supports draft/published workflow with content hash-based change detection
 */

import { getSupabaseAdmin } from '@/lib/supabase-server';
import type { LayerStyle, Layer } from '@/types';
import { generateComponentContentHash, generateLayerStyleContentHash, generatePageLayersHash } from '../hash-utils';
import { updateLayersWithStyle } from '@/lib/layer-style-utils';
import type { ComponentVariant } from '@/types';
import { resolveEffectiveTenantId } from '@/lib/masjidweb/effective-tenant-id';
import { applyTenantEq } from '@/lib/masjidweb/apply-tenant-eq';

/**
 * Input data for creating a new layer style
 */
export interface CreateLayerStyleData {
  name: string;
  classes: string;
  design?: LayerStyle['design'];
  group?: string;
}

/**
 * Affected entity when deleting a layer style
 */
export interface LayerStyleAffectedEntity {
  type: 'page' | 'component';
  id: string;
  name: string;
  pageId?: string; // For pages, this is the page.id (not page_layers.id)
  previousLayers: Layer[];
  newLayers: Layer[];
}

/**
 * Result of soft delete operation
 */
export interface LayerStyleSoftDeleteResult {
  layerStyle: LayerStyle;
  affectedEntities: LayerStyleAffectedEntity[];
}

/**
 * Get all layer styles (draft by default, excludes soft deleted)
 */
export async function getAllStyles(isPublished: boolean = false): Promise<LayerStyle[]> {
  const client = await getSupabaseAdmin();
  if (!client) {
    throw new Error('Failed to initialize Supabase client');
  }

  const tenantId = await resolveEffectiveTenantId();
  let query = client
    .from('layer_styles')
    .select('*')
    .eq('is_published', isPublished)
    .is('deleted_at', null)
    .order('created_at', { ascending: false });
  query = applyTenantEq(query, tenantId);
  const { data, error } = await query;

  if (error) {
    throw new Error(`Failed to fetch layer styles: ${error.message}`);
  }

  return data || [];
}

/**
 * Get a single layer style by ID (draft by default, excludes soft deleted)
 * With composite primary key, we need to specify is_published to get a single row
 */
export async function getStyleById(id: string, isPublished: boolean = false): Promise<LayerStyle | null> {
  const client = await getSupabaseAdmin();
  if (!client) {
    throw new Error('Failed to initialize Supabase client');
  }

  const tenantId = await resolveEffectiveTenantId();
  let query = client
    .from('layer_styles')
    .select('*')
    .eq('id', id)
    .eq('is_published', isPublished)
    .is('deleted_at', null);
  query = applyTenantEq(query, tenantId);
  const { data, error } = await query.single();

  if (error) {
    if (error.code === 'PGRST116') {
      return null; // Not found
    }
    throw new Error(`Failed to fetch layer style: ${error.message}`);
  }

  return data;
}

/**
 * Get a layer style by ID including soft deleted (for restoration)
 */
export async function getStyleByIdIncludingDeleted(id: string, isPublished: boolean = false): Promise<LayerStyle | null> {
  const client = await getSupabaseAdmin();
  if (!client) {
    throw new Error('Failed to initialize Supabase client');
  }

  const tenantId = await resolveEffectiveTenantId();
  let query = client
    .from('layer_styles')
    .select('*')
    .eq('id', id)
    .eq('is_published', isPublished);
  query = applyTenantEq(query, tenantId);
  const { data, error } = await query.single();

  if (error) {
    if (error.code === 'PGRST116') {
      return null; // Not found
    }
    throw new Error(`Failed to fetch layer style: ${error.message}`);
  }

  return data;
}

/**
 * Create a new layer style (draft by default)
 */
export async function createStyle(
  styleData: CreateLayerStyleData
): Promise<LayerStyle> {
  const client = await getSupabaseAdmin();
  if (!client) {
    throw new Error('Failed to initialize Supabase client');
  }

  const tenantId = await resolveEffectiveTenantId();

  // Calculate content hash
  const contentHash = generateLayerStyleContentHash({
    name: styleData.name,
    classes: styleData.classes,
    design: styleData.design,
  });

  const { data, error } = await client
    .from('layer_styles')
    .insert({
      name: styleData.name,
      classes: styleData.classes,
      design: styleData.design,
      group: styleData.group,
      content_hash: contentHash,
      is_published: false,
      ...(tenantId ? { tenant_id: tenantId } : {}),
    })
    .select()
    .single();

  if (error) {
    throw new Error(`Failed to create layer style: ${error.message}`);
  }

  return data;
}

/**
 * Update a layer style and recalculate content hash
 */
export async function updateStyle(
  id: string,
  updates: Partial<Pick<LayerStyle, 'name' | 'classes' | 'design'>>
): Promise<LayerStyle> {
  const client = await getSupabaseAdmin();
  if (!client) {
    throw new Error('Failed to initialize Supabase client');
  }

  const tenantId = await resolveEffectiveTenantId();

  // Get current style to merge with updates
  const current = await getStyleById(id);
  if (!current) {
    throw new Error('Layer style not found');
  }

  // Merge current data with updates for hash calculation
  const finalData = {
    name: updates.name !== undefined ? updates.name : current.name,
    classes: updates.classes !== undefined ? updates.classes : current.classes,
    design: updates.design !== undefined ? updates.design : current.design,
  };

  // Recalculate content hash
  const contentHash = generateLayerStyleContentHash(finalData);

  let updateQuery = client
    .from('layer_styles')
    .update({
      ...updates,
      content_hash: contentHash,
      updated_at: new Date().toISOString(),
    })
    .eq('id', id)
    .eq('is_published', false);
  updateQuery = applyTenantEq(updateQuery, tenantId);
  const { data, error } = await updateQuery.select().single();

  if (error) {
    throw new Error(`Failed to update layer style: ${error.message}`);
  }

  return data;
}

/**
 * Get published layer style by ID
 * Used to find the published version of a draft layer style
 */
export async function getPublishedStyleById(id: string): Promise<LayerStyle | null> {
  const client = await getSupabaseAdmin();
  if (!client) {
    throw new Error('Failed to initialize Supabase client');
  }

  const tenantId = await resolveEffectiveTenantId();
  let query = client
    .from('layer_styles')
    .select('*')
    .eq('id', id)
    .eq('is_published', true);
  query = applyTenantEq(query, tenantId);
  const { data, error } = await query.single();

  if (error) {
    if (error.code === 'PGRST116') {
      return null; // Not found
    }
    throw new Error(`Failed to fetch published layer style: ${error.message}`);
  }

  return data;
}

/**
 * Publish a layer style (dual-record pattern like pages and components)
 * Creates/updates a separate published version while keeping draft untouched
 * Uses composite primary key (id, is_published) - same ID for draft and published versions
 */
export async function publishLayerStyle(draftStyleId: string): Promise<LayerStyle> {
  const client = await getSupabaseAdmin();
  if (!client) {
    throw new Error('Failed to initialize Supabase client');
  }

  const tenantId = await resolveEffectiveTenantId();

  // Get the draft style
  const draftStyle = await getStyleById(draftStyleId);
  if (!draftStyle) {
    throw new Error('Draft layer style not found');
  }

  // Upsert published version - composite key handles insert/update automatically
  const { data, error } = await client
    .from('layer_styles')
    .upsert({
      id: draftStyle.id,
      name: draftStyle.name,
      classes: draftStyle.classes,
      design: draftStyle.design,
      group: draftStyle.group,
      content_hash: draftStyle.content_hash,
      is_published: true,
      updated_at: new Date().toISOString(),
      ...(tenantId ? { tenant_id: tenantId } : {}),
    }, {
      onConflict: 'id,is_published',
    })
    .select()
    .single();

  if (error) {
    throw new Error(`Failed to publish layer style: ${error.message}`);
  }

  return data;
}

/**
 * Publish multiple layer styles in batch
 * Uses batch upsert for efficiency
 */
export async function publishLayerStyles(styleIds: string[]): Promise<{ count: number; changedStyleIds: string[] }> {
  if (styleIds.length === 0) {
    return { count: 0, changedStyleIds: [] };
  }

  const client = await getSupabaseAdmin();
  if (!client) {
    throw new Error('Failed to initialize Supabase client');
  }

  const tenantId = await resolveEffectiveTenantId();

  // Batch fetch all draft styles
  let fetchQuery = client
    .from('layer_styles')
    .select('*')
    .in('id', styleIds)
    .eq('is_published', false);
  fetchQuery = applyTenantEq(fetchQuery, tenantId);
  const { data: draftStyles, error: fetchError } = await fetchQuery;

  if (fetchError) {
    throw new Error(`Failed to fetch draft layer styles: ${fetchError.message}`);
  }

  if (!draftStyles || draftStyles.length === 0) {
    return { count: 0, changedStyleIds: [] };
  }

  let publishedQuery = client
    .from('layer_styles')
    .select('id, content_hash')
    .in('id', draftStyles.map((s) => s.id))
    .eq('is_published', true);
  publishedQuery = applyTenantEq(publishedQuery, tenantId);
  const { data: publishedStyles } = await publishedQuery;

  const publishedHashById = new Map<string, string>();
  for (const pub of publishedStyles || []) {
    if (pub.content_hash) publishedHashById.set(pub.id, pub.content_hash);
  }

  const stylesToUpsert = draftStyles
    .filter((draft) => {
      const pubHash = publishedHashById.get(draft.id);
      return !pubHash || pubHash !== draft.content_hash;
    })
    .map(draft => ({
      id: draft.id,
      name: draft.name,
      classes: draft.classes,
      design: draft.design,
      group: draft.group,
      content_hash: draft.content_hash,
      is_published: true,
      updated_at: new Date().toISOString(),
      ...(tenantId ? { tenant_id: tenantId } : {}),
    }));

  // Batch upsert all styles
  const { error: upsertError } = await client
    .from('layer_styles')
    .upsert(stylesToUpsert, {
      onConflict: 'id,is_published',
    });

  if (upsertError) {
    throw new Error(`Failed to publish layer styles: ${upsertError.message}`);
  }

  return {
    count: stylesToUpsert.length,
    changedStyleIds: stylesToUpsert.map((s) => s.id),
  };
}

/**
 * Get all unpublished layer styles
 * A layer style needs publishing if:
 * - It has is_published: false (never published), OR
 * - Its draft content_hash differs from published content_hash (needs republishing)
 */
export async function getUnpublishedLayerStyles(): Promise<LayerStyle[]> {
  const client = await getSupabaseAdmin();
  if (!client) {
    throw new Error('Failed to initialize Supabase client');
  }

  const tenantId = await resolveEffectiveTenantId();

  // Get all draft layer styles
  let draftQuery = client
    .from('layer_styles')
    .select('*')
    .eq('is_published', false)
    .order('created_at', { ascending: false });
  draftQuery = applyTenantEq(draftQuery, tenantId);
  const { data: draftStyles, error } = await draftQuery;

  if (error) {
    throw new Error(`Failed to fetch draft layer styles: ${error.message}`);
  }

  if (!draftStyles || draftStyles.length === 0) {
    return [];
  }

  const unpublishedStyles: LayerStyle[] = [];

  // Batch fetch all published styles for the draft IDs
  const draftIds = draftStyles.map(s => s.id);
  let publishedQuery = client
    .from('layer_styles')
    .select('*')
    .in('id', draftIds)
    .eq('is_published', true);
  publishedQuery = applyTenantEq(publishedQuery, tenantId);
  const { data: publishedStyles, error: publishedError } = await publishedQuery;

  if (publishedError) {
    throw new Error(`Failed to fetch published layer styles: ${publishedError.message}`);
  }

  // Build lookup map
  const publishedById = new Map<string, LayerStyle>();
  (publishedStyles || []).forEach(s => publishedById.set(s.id, s));

  // Check each draft style
  for (const draftStyle of draftStyles) {
    // Check if published version exists
    const publishedStyle = publishedById.get(draftStyle.id);

    // If no published version exists, needs first-time publishing
    if (!publishedStyle) {
      unpublishedStyles.push(draftStyle);
      continue;
    }

    // Compare content hashes
    if (draftStyle.content_hash !== publishedStyle.content_hash) {
      unpublishedStyles.push(draftStyle);
    }
  }

  return unpublishedStyles;
}

/**
 * Hard-delete soft-deleted draft layer styles and their published counterparts.
 */
export async function hardDeleteSoftDeletedLayerStyles(): Promise<{ count: number }> {
  const client = await getSupabaseAdmin();
  if (!client) {
    throw new Error('Failed to initialize Supabase client');
  }

  const tenantId = await resolveEffectiveTenantId();

  let selectQuery = client
    .from('layer_styles')
    .select('id')
    .eq('is_published', false)
    .not('deleted_at', 'is', null);
  selectQuery = applyTenantEq(selectQuery, tenantId);
  const { data: deletedDrafts, error } = await selectQuery;

  if (error) {
    throw new Error(`Failed to fetch deleted draft layer styles: ${error.message}`);
  }

  if (!deletedDrafts || deletedDrafts.length === 0) {
    return { count: 0 };
  }

  const ids = deletedDrafts.map(s => s.id);

  let pubDeleteQuery = client
    .from('layer_styles')
    .delete()
    .in('id', ids)
    .eq('is_published', true);
  pubDeleteQuery = applyTenantEq(pubDeleteQuery, tenantId);
  const { error: pubError } = await pubDeleteQuery;

  if (pubError) {
    console.error('Failed to delete published layer styles:', pubError);
  }

  let draftDeleteQuery = client
    .from('layer_styles')
    .delete()
    .in('id', ids)
    .eq('is_published', false)
    .not('deleted_at', 'is', null);
  draftDeleteQuery = applyTenantEq(draftDeleteQuery, tenantId);
  const { error: draftError } = await draftDeleteQuery;

  if (draftError) {
    throw new Error(`Failed to delete draft layer styles: ${draftError.message}`);
  }

  return { count: deletedDrafts.length };
}

/**
 * Get count of unpublished layer styles
 */
export async function getUnpublishedLayerStylesCount(): Promise<number> {
  const styles = await getUnpublishedLayerStyles();
  return styles.length;
}

/**
 * Check if layers contain a reference to a specific layer style
 */
function layersContainStyle(layers: Layer[], styleId: string): boolean {
  for (const layer of layers) {
    if (layer.styleId === styleId) {
      return true;
    }
    if (layer.children && layersContainStyle(layer.children, styleId)) {
      return true;
    }
  }
  return false;
}

/**
 * Helper function to recursively remove styleId from layers
 */
function detachStyleFromLayersRecursive(layers: Layer[], styleId: string): Layer[] {
  return layers.map(layer => {
    // Create a clean copy of the layer
    const cleanLayer = { ...layer };

    // If this layer uses the style, remove styleId and styleOverrides
    if (cleanLayer.styleId === styleId) {
      delete cleanLayer.styleId;
      delete cleanLayer.styleOverrides;
    }

    // Recursively process children
    if (cleanLayer.children && cleanLayer.children.length > 0) {
      cleanLayer.children = detachStyleFromLayersRecursive(cleanLayer.children, styleId);
    }

    return cleanLayer;
  });
}

/**
 * Find all entities (pages and components) using a layer style
 * Returns detailed info including previous and new layers for undo/redo
 */
export async function findEntitiesUsingLayerStyle(styleId: string): Promise<LayerStyleAffectedEntity[]> {
  const client = await getSupabaseAdmin();
  if (!client) {
    throw new Error('Failed to initialize Supabase client');
  }

  const tenantId = await resolveEffectiveTenantId();
  const affectedEntities: LayerStyleAffectedEntity[] = [];

  // Find affected page_layers
  let pageLayersQuery = client
    .from('page_layers')
    .select('id, page_id, layers')
    .eq('is_published', false)
    .is('deleted_at', null);
  pageLayersQuery = applyTenantEq(pageLayersQuery, tenantId);
  const { data: pageLayersRecords, error: pageError } = await pageLayersQuery;

  if (pageError) {
    throw new Error(`Failed to fetch page layers: ${pageError.message}`);
  }

  // Get page info for affected pages
  const affectedPageLayerIds = (pageLayersRecords || [])
    .filter(record => layersContainStyle(record.layers || [], styleId))
    .map(record => record.page_id);

  if (affectedPageLayerIds.length > 0) {
    let pagesQuery = client
      .from('pages')
      .select('id, name')
      .in('id', affectedPageLayerIds)
      .eq('is_published', false)
      .is('deleted_at', null);
    pagesQuery = applyTenantEq(pagesQuery, tenantId);
    const { data: pages, error: pagesError } = await pagesQuery;

    if (pagesError) {
      throw new Error(`Failed to fetch pages: ${pagesError.message}`);
    }

    const pageMap = new Map((pages || []).map(p => [p.id, p.name]));

    for (const record of pageLayersRecords || []) {
      if (layersContainStyle(record.layers || [], styleId)) {
        const newLayers = detachStyleFromLayersRecursive(record.layers || [], styleId);
        affectedEntities.push({
          type: 'page',
          id: record.id,
          name: pageMap.get(record.page_id) || 'Unknown Page',
          pageId: record.page_id,
          previousLayers: record.layers || [],
          newLayers,
        });
      }
    }
  }

  // Find affected components
  let componentsQuery = client
    .from('components')
    .select('id, name, layers')
    .eq('is_published', false)
    .is('deleted_at', null);
  componentsQuery = applyTenantEq(componentsQuery, tenantId);
  const { data: componentRecords, error: compError } = await componentsQuery;

  if (compError) {
    throw new Error(`Failed to fetch components: ${compError.message}`);
  }

  for (const record of componentRecords || []) {
    if (layersContainStyle(record.layers || [], styleId)) {
      const newLayers = detachStyleFromLayersRecursive(record.layers || [], styleId);
      affectedEntities.push({
        type: 'component',
        id: record.id,
        name: record.name,
        previousLayers: record.layers || [],
        newLayers,
      });
    }
  }

  return affectedEntities;
}

/**
 * Soft delete a layer style and detach it from all layers
 * Returns the deleted style and affected entities for undo/redo
 */
export async function softDeleteStyle(id: string): Promise<LayerStyleSoftDeleteResult> {
  const client = await getSupabaseAdmin();
  if (!client) {
    throw new Error('Failed to initialize Supabase client');
  }

  const tenantId = await resolveEffectiveTenantId();

  // Get the layer style before deleting
  let fetchQuery = client
    .from('layer_styles')
    .select('*')
    .eq('id', id)
    .eq('is_published', false)
    .is('deleted_at', null);
  fetchQuery = applyTenantEq(fetchQuery, tenantId);
  const { data: layerStyle, error: fetchError } = await fetchQuery.single();

  if (fetchError || !layerStyle) {
    throw new Error('Layer style not found');
  }

  // Find all affected entities
  const affectedEntities = await findEntitiesUsingLayerStyle(id);

  // Detach style from all affected page_layers
  for (const entity of affectedEntities) {
    if (entity.type === 'page') {
      let pageUpdateQuery = client
        .from('page_layers')
        .update({
          layers: entity.newLayers,
          updated_at: new Date().toISOString(),
        })
        .eq('id', entity.id);
      pageUpdateQuery = applyTenantEq(pageUpdateQuery, tenantId);
      const { error: updateError } = await pageUpdateQuery;

      if (updateError) {
        console.error(`Failed to update page_layers ${entity.id}:`, updateError);
      }
    } else if (entity.type === 'component') {
      let compUpdateQuery = client
        .from('components')
        .update({
          layers: entity.newLayers,
          updated_at: new Date().toISOString(),
        })
        .eq('id', entity.id)
        .eq('is_published', false);
      compUpdateQuery = applyTenantEq(compUpdateQuery, tenantId);
      const { error: updateError } = await compUpdateQuery;

      if (updateError) {
        console.error(`Failed to update component ${entity.id}:`, updateError);
      }
    }
  }

  // Soft delete the style (both draft and published versions)
  const deletedAt = new Date().toISOString();
  let deleteQuery = client
    .from('layer_styles')
    .update({ deleted_at: deletedAt })
    .eq('id', id);
  deleteQuery = applyTenantEq(deleteQuery, tenantId);
  const { error: deleteError } = await deleteQuery;

  if (deleteError) {
    throw new Error(`Failed to soft delete layer style: ${deleteError.message}`);
  }

  return {
    layerStyle: { ...layerStyle, deleted_at: deletedAt },
    affectedEntities,
  };
}

/**
 * Restore a soft-deleted layer style
 */
export async function restoreLayerStyle(id: string): Promise<LayerStyle> {
  const client = await getSupabaseAdmin();
  if (!client) {
    throw new Error('Failed to initialize Supabase client');
  }

  const tenantId = await resolveEffectiveTenantId();
  let query = client
    .from('layer_styles')
    .update({ deleted_at: null })
    .eq('id', id)
    .eq('is_published', false);
  query = applyTenantEq(query, tenantId);
  const { data, error } = await query.select().single();

  if (error) {
    throw new Error(`Failed to restore layer style: ${error.message}`);
  }

  return data;
}

/**
 * Hard delete a layer style (permanent, use with caution)
 * @deprecated Use softDeleteStyle instead for undo/redo support
 */
export async function deleteStyle(id: string): Promise<void> {
  const client = await getSupabaseAdmin();
  if (!client) {
    throw new Error('Failed to initialize Supabase client');
  }

  const tenantId = await resolveEffectiveTenantId();
  let query = client
    .from('layer_styles')
    .delete()
    .eq('id', id);
  query = applyTenantEq(query, tenantId);
  const { error } = await query;

  if (error) {
    throw new Error(`Failed to delete layer style: ${error.message}`);
  }
}

/**
 * Propagate published layer style values into draft page_layers and components.
 * Tenant-scoped when effective tenant context is available.
 */
export async function syncLayerStyleChangesToDrafts(
  styleIds: string[],
): Promise<{ affectedPageIds: string[]; affectedComponentIds: string[] }> {
  if (styleIds.length === 0) {
    return { affectedPageIds: [], affectedComponentIds: [] };
  }

  const client = await getSupabaseAdmin();
  if (!client) {
    return { affectedPageIds: [], affectedComponentIds: [] };
  }

  const tenantId = await resolveEffectiveTenantId();

  let stylesQuery = client
    .from('layer_styles')
    .select('id, classes, design')
    .in('id', styleIds)
    .eq('is_published', true)
    .is('deleted_at', null);
  stylesQuery = applyTenantEq(stylesQuery, tenantId);
  const { data: styles } = await stylesQuery;

  if (!styles || styles.length === 0) {
    return { affectedPageIds: [], affectedComponentIds: [] };
  }

  let pageLayersQuery = client
    .from('page_layers')
    .select('id, page_id, layers, generated_css, content_hash')
    .eq('is_published', false)
    .is('deleted_at', null);
  pageLayersQuery = applyTenantEq(pageLayersQuery, tenantId);
  const { data: pageLayersRecords } = await pageLayersQuery;

  const affectedPageIds: string[] = [];
  const now = new Date().toISOString();

  for (const record of pageLayersRecords || []) {
    if (!Array.isArray(record.layers)) continue;

    let layers = record.layers as Layer[];
    for (const style of styles) {
      layers = updateLayersWithStyle(layers, style.id, style.classes, style.design);
    }

    const newHash = generatePageLayersHash({
      layers,
      generated_css: record.generated_css || null,
    });

    if (newHash !== record.content_hash) {
      affectedPageIds.push(record.page_id);
      let updateQuery = client
        .from('page_layers')
        .update({ layers, content_hash: newHash, updated_at: now })
        .eq('id', record.id)
        .eq('is_published', false);
      updateQuery = applyTenantEq(updateQuery, tenantId);
      await updateQuery;
    }
  }

  let componentsQuery = client
    .from('components')
    .select('id, name, layers, variants, variables, content_hash')
    .eq('is_published', false)
    .is('deleted_at', null);
  componentsQuery = applyTenantEq(componentsQuery, tenantId);
  const { data: componentRecords } = await componentsQuery;

  const affectedComponentIds: string[] = [];

  for (const record of componentRecords || []) {
    if (!Array.isArray(record.layers)) continue;

    let layers = record.layers as Layer[];
    for (const style of styles) {
      layers = updateLayersWithStyle(layers, style.id, style.classes, style.design);
    }

    let variants: ComponentVariant[] | undefined = record.variants as ComponentVariant[] | undefined;
    if (Array.isArray(variants) && variants.length > 0) {
      variants = variants.map((v, i) => {
        if (i === 0) return { ...v, layers };
        let variantLayers = v.layers as Layer[] ?? [];
        for (const style of styles) {
          variantLayers = updateLayersWithStyle(variantLayers, style.id, style.classes, style.design);
        }
        return { ...v, layers: variantLayers };
      });
    }

    const newHash = generateComponentContentHash({
      name: record.name,
      layers,
      variables: record.variables,
      variants,
    });

    if (newHash !== record.content_hash) {
      affectedComponentIds.push(record.id);
      let updateQuery = client
        .from('components')
        .update({
          layers,
          ...(variants ? { variants } : {}),
          content_hash: newHash,
          updated_at: now,
        })
        .eq('id', record.id)
        .eq('is_published', false);
      updateQuery = applyTenantEq(updateQuery, tenantId);
      await updateQuery;
    }
  }

  return { affectedPageIds, affectedComponentIds };
}
