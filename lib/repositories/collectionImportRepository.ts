import { resolveEffectiveTenantId } from '@/lib/masjidweb/effective-tenant-id';
import { getSupabaseAdmin } from '@/lib/supabase-server';
import { STORAGE_BUCKET } from '@/lib/asset-constants';
import { getCollectionById } from '@/lib/repositories/collectionRepository';
import type { CollectionImport, CollectionImportStatus } from '@/types';
import { applyTenantEq } from '@/lib/masjidweb/apply-tenant-eq';

/**
 * Collection Import Repository
 *
 * Handles CRUD operations for CSV import jobs.
 * Supports background processing with status tracking.
 */

export interface CreateImportData {
  collection_id: string;
  column_mapping: Record<string, string>;
  total_rows: number;
  csv_storage_path: string;
}

/**
 * Create a new import job
 */
export async function createImport(data: CreateImportData): Promise<CollectionImport> {
  const tenantId = await resolveEffectiveTenantId();
  const client = await getSupabaseAdmin();

  if (!client) {
    throw new Error('Supabase client not configured');
  }

  const collection = await getCollectionById(data.collection_id, false, true);
  if (!collection) {
    throw new Error('Collection not found');
  }

  const { data: result, error } = await client
    .from('collection_imports')
    .insert({ tenant_id: tenantId,
      collection_id: data.collection_id,
      column_mapping: data.column_mapping,
      csv_data: { storage_path: data.csv_storage_path },
      total_rows: data.total_rows,
      status: 'pending',
      processed_rows: 0,
      failed_rows: 0,
      errors: [],
    })
    .select()
    .single();

  if (error) {
    throw new Error(`Failed to create import: ${error.message}`);
  }

  return result;
}

/**
 * Get import by ID
 */
export async function getImportById(id: string): Promise<CollectionImport | null> {
  const tenantId = await resolveEffectiveTenantId();
  const client = await getSupabaseAdmin();

  if (!client) {
    throw new Error('Supabase client not configured');
  }

  const { data, error } = await applyTenantEq(client
    .from('collection_imports')
    .select('*')
    .eq('id', id)
    .single(), tenantId);

  if (error && error.code !== 'PGRST116') {
    throw new Error(`Failed to fetch import: ${error.message}`);
  }

  if (!data) {
    return null;
  }

  const collection = await getCollectionById(data.collection_id, false, true);
  if (!collection) {
    return null;
  }

  return data;
}

/**
 * Get pending or processing imports (for background processing)
 */
export async function getPendingImports(limit: number = 5): Promise<CollectionImport[]> {
  const client = await getSupabaseAdmin();

  if (!client) {
    throw new Error('Supabase client not configured');
  }

  const tenantId = await resolveEffectiveTenantId();

  const fetchLimit = tenantId ? Math.max(limit * 20, limit) : limit;

  const { data: raw, error } = await applyTenantEq(client
    .from('collection_imports')
    .select('*')
    .in('status', ['pending', 'processing'])
    .order('created_at', { ascending: true })
    .limit(fetchLimit), tenantId);

  if (error) {
    throw new Error(`Failed to fetch pending imports: ${error.message}`);
  }

  const rows = raw || [];

  if (!tenantId) {
    return rows.slice(0, limit);
  }

  const visible: CollectionImport[] = [];
  for (const row of rows) {
    const col = await getCollectionById(row.collection_id, false, true);
    if (col) {
      visible.push(row);
    }
    if (visible.length >= limit) break;
  }

  return visible;
}

/**
 * Update import status
 */
export async function updateImportStatus(
  id: string,
  status: CollectionImportStatus
): Promise<void> {
  const tenantId = await resolveEffectiveTenantId();
  const client = await getSupabaseAdmin();

  if (!client) {
    throw new Error('Supabase client not configured');
  }

  const existing = await getImportById(id);
  if (!existing) {
    throw new Error('Import not found');
  }

  const { error } = await applyTenantEq(client
    .from('collection_imports')
    .update({
      status,
      updated_at: new Date().toISOString(),
    })
    .eq('id', id), tenantId);

  if (error) {
    throw new Error(`Failed to update import status: ${error.message}`);
  }
}

/**
 * Update import progress
 */
export async function updateImportProgress(
  id: string,
  processedRows: number,
  failedRows: number,
  errors: string[] | null = null
): Promise<void> {
  const tenantId = await resolveEffectiveTenantId();
  const client = await getSupabaseAdmin();

  if (!client) {
    throw new Error('Supabase client not configured');
  }

  const existing = await getImportById(id);
  if (!existing) {
    throw new Error('Import not found');
  }

  const updateData: Record<string, unknown> = {
    processed_rows: processedRows,
    failed_rows: failedRows,
    updated_at: new Date().toISOString(),
  };

  if (errors !== null) {
    updateData.errors = errors;
  }

  const { error } = await applyTenantEq(client
    .from('collection_imports')
    .update(updateData)
    .eq('id', id), tenantId);

  if (error) {
    throw new Error(`Failed to update import progress: ${error.message}`);
  }
}

/**
 * Mark import as completed
 */
export async function completeImport(
  id: string,
  processedRows: number,
  failedRows: number,
  errors: string[]
): Promise<void> {
  const tenantId = await resolveEffectiveTenantId();
  const client = await getSupabaseAdmin();

  if (!client) {
    throw new Error('Supabase client not configured');
  }

  const existing = await getImportById(id);
  if (!existing) {
    throw new Error('Import not found');
  }

  const status: CollectionImportStatus = failedRows > 0 && processedRows === 0 ? 'failed' : 'completed';

  const { error } = await applyTenantEq(client
    .from('collection_imports')
    .update({
      status,
      processed_rows: processedRows,
      failed_rows: failedRows,
      errors: errors.length > 0 ? errors : null,
      updated_at: new Date().toISOString(),
    })
    .eq('id', id), tenantId);

  if (error) {
    throw new Error(`Failed to complete import: ${error.message}`);
  }
}

/**
 * Delete import job
 */
export async function deleteImport(id: string): Promise<void> {
  const tenantId = await resolveEffectiveTenantId();
  const client = await getSupabaseAdmin();

  if (!client) {
    throw new Error('Supabase client not configured');
  }

  const existing = await getImportById(id);
  if (!existing) {
    throw new Error('Import not found');
  }

  const { error } = await applyTenantEq(client
    .from('collection_imports')
    .delete()
    .eq('id', id), tenantId);

  if (error) {
    throw new Error(`Failed to delete import: ${error.message}`);
  }
}

/**
 * Get imports for a collection
 */
export async function getImportsByCollectionId(collectionId: string): Promise<CollectionImport[]> {
  const tenantId = await resolveEffectiveTenantId();
  const client = await getSupabaseAdmin();

  if (!client) {
    throw new Error('Supabase client not configured');
  }

  const collection = await getCollectionById(collectionId, false, true);
  if (!collection) {
    return [];
  }

  const { data, error } = await applyTenantEq(client
    .from('collection_imports')
    .select('*')
    .eq('collection_id', collectionId)
    .order('created_at', { ascending: false }), tenantId);

  if (error) {
    throw new Error(`Failed to fetch imports: ${error.message}`);
  }

  return data || [];
}

const STALE_IMPORT_HOURS = 2;

/**
 * Clean up stale import jobs and their CSV files from storage.
 * Targets imports older than STALE_IMPORT_HOURS that are still pending/processing
 * (i.e. the user closed the page or the server crashed).
 */
export async function cleanupStaleImports(): Promise<void> {
  const tenantId = await resolveEffectiveTenantId();
  const client = await getSupabaseAdmin();
  if (!client) return;

  const cutoff = new Date(Date.now() - STALE_IMPORT_HOURS * 60 * 60 * 1000).toISOString();

  const { data: staleImports, error } = await applyTenantEq(client
    .from('collection_imports')
    .select('id, csv_data')
    .in('status', ['pending', 'processing'])
    .lt('updated_at', cutoff), tenantId);

  if (error || !staleImports?.length) return;

  // Collect storage paths to delete in one batch
  const storagePaths: string[] = [];
  const importIds: string[] = [];

  for (const imp of staleImports) {
    importIds.push(imp.id);
    const csvData = imp.csv_data as { storage_path?: string } | null;
    if (csvData?.storage_path) {
      storagePaths.push(csvData.storage_path);
    }
  }

  // Remove CSV files from storage
  if (storagePaths.length > 0) {
    try {
      await client.storage.from(STORAGE_BUCKET).remove(storagePaths);
    } catch { /* best-effort */ }
  }

  // Mark stale imports as failed
  await applyTenantEq(client
    .from('collection_imports')
    .update({ status: 'failed' as CollectionImportStatus, updated_at: new Date().toISOString() })
    .in('id', importIds), tenantId);
}
