/**
 * Sync Utilities
 *
 * Shared logic for publishing (draft → published) and reverting (published → draft).
 * Both operations follow the same pattern with inverted is_published values.
 */

import { getSupabaseAdmin } from '@/lib/supabase-server';
import { SUPABASE_QUERY_LIMIT, SUPABASE_WRITE_BATCH_SIZE } from '@/lib/supabase-constants';
import { resolveEffectiveTenantId } from '@/lib/masjidweb/effective-tenant-id';
import { applyTenantEq } from '@/lib/masjidweb/apply-tenant-eq';

/** Direction of the sync operation */
export type SyncDirection = 'publish' | 'revert';

/**
 * Fetch every matching row across pages, since a plain `.select()` is capped
 * at SUPABASE_QUERY_LIMIT (1000) by PostgREST's default row limit. Confirmed
 * live on production: tenant high900 alone has 1872 draft / 1856 published
 * collection_item_values rows — well past 1000 — so an unpaginated fetch here
 * silently truncates, which either skips rows a sync should have moved, or
 * (via the naturalKey lookup below) causes false "no existing row" misses
 * that re-trigger the exact duplicate-key failure the naturalKey fix exists
 * to prevent.
 *
 * Orders by `id` so page boundaries are stable across the multiple round-trip
 * queries this makes — `.range()` (LIMIT/OFFSET) has no guaranteed row order
 * without an explicit sort, so two pages fetched moments apart could silently
 * skip or duplicate rows under concurrent writes (exactly the condition
 * revert/publish run under) if left unordered.
 *
 * Tenant-scoped via `applyTenantEq`: this is the only defense-in-depth layer
 * here when `getSupabaseAdmin()` falls back to the service-role client (RLS
 * bypassed) — e.g. if MW_TENANT_RLS_ENFORCE is ever off, which has happened
 * multiple times this session during incident response. Without this, a
 * revert/publish call would sync/revert every tenant's rows in one table, not
 * just the caller's.
 */
async function fetchAllRows(
  client: Awaited<ReturnType<typeof getSupabaseAdmin>>,
  tableName: string,
  columns: string,
  isPublished: boolean,
  options?: { ids?: string[]; excludeDeleted?: boolean; tenantId?: string | null },
): Promise<Record<string, unknown>[]> {
  const all: Record<string, unknown>[] = [];
  let offset = 0;
  for (;;) {
    let query = client!
      .from(tableName)
      .select(columns)
      .eq('is_published', isPublished)
      .order('id')
      .range(offset, offset + SUPABASE_QUERY_LIMIT - 1);
    if (options?.excludeDeleted !== false) {
      query = query.is('deleted_at', null);
    }
    if (options?.ids && options.ids.length > 0) {
      query = query.in('id', options.ids);
    }
    query = applyTenantEq(query, options?.tenantId);
    const { data, error } = await query;
    if (error) {
      throw new Error(`Failed to fetch ${tableName} rows: ${error.message}`);
    }
    const batch = (data || []) as unknown as Record<string, unknown>[];
    all.push(...batch);
    if (batch.length < SUPABASE_QUERY_LIMIT) break;
    offset += SUPABASE_QUERY_LIMIT;
  }
  return all;
}

/** Returns the source/target is_published flags for a given direction */
export function getSyncFlags(direction: SyncDirection) {
  return {
    source: direction === 'publish' ? false : true,
    target: direction === 'publish' ? true : false,
  } as const;
}

/**
 * Sync rows from source to target for a given table.
 * Copies all active (non-soft-deleted) rows from source side to target side
 * using upsert with the (id, is_published) composite key.
 *
 * This only works unmodified for tables where a row's `id` is shared between
 * its draft and published copies (e.g. pages, collections, collection_items —
 * confirmed by design: the row is one logical entity flagged by is_published,
 * not two independently-created rows). For tables where each publish state
 * gets an independently generated `id` and the real identity is a different
 * column set (e.g. collection_item_values: item_id+field_id; translations:
 * locale_id+source_type+source_id+content_key), reusing the source row's own
 * `id` on the opposite side makes the (id, is_published) conflict target miss
 * any existing counterpart row, so the upsert falls through to a plain INSERT
 * that then collides with that table's OWN unique constraint on the real
 * identity columns — the same failure mode fixed in
 * collectionItemValueRepository.ts's publishValues() on 2026-07-01. Pass
 * `naturalKey` for those tables so this function looks up the existing
 * counterpart row's id first and reuses it, making the upsert a genuine
 * update instead of a colliding insert.
 *
 * @returns Number of rows synced
 */
export async function syncTableRows(
  tableName: string,
  direction: SyncDirection,
  options?: { ids?: string[]; excludeColumns?: string[]; naturalKey?: string[] }
): Promise<number> {
  const client = await getSupabaseAdmin();

  if (!client) {
    throw new Error('Supabase not configured');
  }

  const { source, target } = getSyncFlags(direction);
  const tenantId = await resolveEffectiveTenantId();

  const sourceRows = await fetchAllRows(client, tableName, '*', source, { ids: options?.ids, tenantId });

  if (sourceRows.length === 0) {
    return 0;
  }

  const naturalKey = options?.naturalKey;
  let existingIdByKey: Map<string, string> | null = null;
  if (naturalKey && naturalKey.length > 0) {
    const existingTargetRows = await fetchAllRows(client, tableName, ['id', ...naturalKey].join(','), target, { tenantId });
    existingIdByKey = new Map(
      existingTargetRows.map((r) => [naturalKey.map(k => r[k]).join(' '), r.id as string])
    );
  }

  const now = new Date().toISOString();
  const exclude = new Set(options?.excludeColumns || []);
  const targetRows = sourceRows.map(row => {
    const mapped: Record<string, unknown> = { ...row, is_published: target, updated_at: now };
    if (existingIdByKey && naturalKey) {
      const key = naturalKey.map(k => (row as Record<string, unknown>)[k]).join(' ');
      const existingId = existingIdByKey.get(key);
      if (existingId) mapped.id = existingId;
    }
    for (const col of exclude) delete mapped[col];
    return mapped;
  });

  for (let i = 0; i < targetRows.length; i += SUPABASE_WRITE_BATCH_SIZE) {
    const batch = targetRows.slice(i, i + SUPABASE_WRITE_BATCH_SIZE);
    const { error: upsertError } = await client
      .from(tableName)
      .upsert(batch, { onConflict: 'id,is_published' });

    if (upsertError) {
      throw new Error(`Failed to sync ${tableName}: ${upsertError.message}`);
    }
  }

  return targetRows.length;
}

export interface CleanupResult {
  deleted: number;
  preservedIds: string[];
  /** Values collected from orphaned rows for the columns specified in options.collectColumns */
  collected: Record<string, string[]>;
}

/**
 * Remove orphaned rows on the target side that have no counterpart on the source side.
 * For revert: deletes draft-only rows (never published).
 * For publish: deletes published-only rows (draft was deleted).
 *
 * @param options.preserveFilter - Protect orphan rows where column equals value; their IDs are returned in preservedIds.
 * @param options.excludeByColumn - Protect orphan rows where the given column's value is in the provided Set.
 * @param options.collectColumns - Column names to collect from orphaned rows before deletion (e.g. ['storage_path']).
 * @param options.naturalKey - For tables where `id` isn't shared between draft/published
 *   rows (see syncTableRows' naturalKey doc), compare by these columns instead of `id`
 *   to determine orphan status — otherwise every row looks orphaned to the other side.
 * @returns Deleted count, preserved orphan IDs, and collected column values
 */
export async function cleanupOrphanedRows(
  tableName: string,
  direction: SyncDirection,
  options?: {
    preserveFilter?: { column: string; value: unknown };
    excludeByColumn?: { column: string; ids: Set<string> };
    collectColumns?: string[];
    naturalKey?: string[];
  }
): Promise<CleanupResult> {
  const client = await getSupabaseAdmin();

  if (!client) {
    throw new Error('Supabase not configured');
  }

  const { source, target } = getSyncFlags(direction);
  const tenantId = await resolveEffectiveTenantId();
  const naturalKey = options?.naturalKey;
  const keyOf = (r: Record<string, unknown>): string =>
    naturalKey ? naturalKey.map(k => r[k]).join(' ') : (r.id as string);

  // Get all source keys (id, or the natural key columns for tables that don't share ids)
  const sourceRows = await fetchAllRows(client, tableName, naturalKey ? naturalKey.join(',') : 'id', source, { tenantId });
  const sourceKeys = new Set(sourceRows.map((r) => keyOf(r)));

  // Get all target rows (matches the original query's scope: no deleted_at filter,
  // since an already soft-deleted target row re-attempting delete is a harmless no-op)
  const targetRows = await fetchAllRows(client, tableName, '*', target, { excludeDeleted: false, tenantId });

  const orphanedIds: string[] = [];
  const preservedIds: string[] = [];
  const collected: Record<string, string[]> = {};
  const { preserveFilter, excludeByColumn, collectColumns } = options || {};

  if (collectColumns) {
    for (const col of collectColumns) collected[col] = [];
  }

  for (const row of targetRows || []) {
    const r = row as Record<string, unknown>;
    const id = r.id as string;

    if (sourceKeys.has(keyOf(r))) continue;

    if (excludeByColumn && excludeByColumn.ids.has(r[excludeByColumn.column] as string)) {
      continue;
    }

    if (preserveFilter && r[preserveFilter.column] === preserveFilter.value) {
      preservedIds.push(id);
    } else {
      orphanedIds.push(id);
      if (collectColumns) {
        for (const col of collectColumns) {
          const val = r[col];
          if (typeof val === 'string' && val) collected[col].push(val);
        }
      }
    }
  }

  if (orphanedIds.length === 0) {
    return { deleted: 0, preservedIds, collected };
  }

  // Delete orphaned rows in batches. orphanedIds is derived entirely from
  // targetRows above (already tenant-scoped), so this delete only ever
  // targets the caller's own tenant's rows by construction — the explicit
  // applyTenantEq here is a second, independent layer of defense-in-depth,
  // not the only thing preventing a cross-tenant delete.
  let deletedCount = 0;
  for (let i = 0; i < orphanedIds.length; i += SUPABASE_WRITE_BATCH_SIZE) {
    const batch = orphanedIds.slice(i, i + SUPABASE_WRITE_BATCH_SIZE);
    let deleteQuery = client
      .from(tableName)
      .delete()
      .eq('is_published', target)
      .in('id', batch);
    deleteQuery = applyTenantEq(deleteQuery, tenantId);
    const { error: deleteError } = await deleteQuery;

    if (deleteError) {
      throw new Error(`Failed to cleanup orphaned ${tableName}: ${deleteError.message}`);
    }

    deletedCount += batch.length;
  }

  return { deleted: deletedCount, preservedIds, collected };
}

/**
 * Sync rows filtered by a parent foreign key instead of by row ID.
 * Used for tables like page_layers and collection_item_values
 * where we sync based on a parent entity.
 *
 * @param parentColumn - The FK column to filter on (e.g. 'page_id', 'item_id')
 * @param parentIds - The parent IDs to sync for
 * @returns Number of rows synced
 */
export async function syncTableRowsByParent(
  tableName: string,
  direction: SyncDirection,
  parentColumn: string,
  parentIds: string[]
): Promise<number> {
  if (parentIds.length === 0) return 0;

  const client = await getSupabaseAdmin();

  if (!client) {
    throw new Error('Supabase not configured');
  }

  const { source, target } = getSyncFlags(direction);
  const now = new Date().toISOString();
  let totalSynced = 0;

  for (let i = 0; i < parentIds.length; i += SUPABASE_WRITE_BATCH_SIZE) {
    const batchIds = parentIds.slice(i, i + SUPABASE_WRITE_BATCH_SIZE);

    const { data: sourceRows, error: fetchError } = await client
      .from(tableName)
      .select('*')
      .eq('is_published', source)
      .is('deleted_at', null)
      .in(parentColumn, batchIds);

    if (fetchError) {
      throw new Error(`Failed to fetch ${tableName} by ${parentColumn}: ${fetchError.message}`);
    }

    if (!sourceRows || sourceRows.length === 0) continue;

    const targetRows = sourceRows.map(row => ({
      ...row,
      is_published: target,
      updated_at: now,
    }));

    for (let j = 0; j < targetRows.length; j += SUPABASE_WRITE_BATCH_SIZE) {
      const batch = targetRows.slice(j, j + SUPABASE_WRITE_BATCH_SIZE);
      const { error: upsertError } = await client
        .from(tableName)
        .upsert(batch, { onConflict: 'id,is_published' });

      if (upsertError) {
        throw new Error(`Failed to sync ${tableName} by ${parentColumn}: ${upsertError.message}`);
      }
    }

    totalSynced += targetRows.length;
  }

  return totalSynced;
}

/**
 * Remove orphaned child rows on the target side by parent FK.
 * Used after syncTableRowsByParent to clean up children whose parents were removed.
 */
export async function cleanupOrphanedChildRows(
  tableName: string,
  direction: SyncDirection,
  parentColumn: string,
  parentTable: string
): Promise<number> {
  const client = await getSupabaseAdmin();

  if (!client) {
    throw new Error('Supabase not configured');
  }

  const { source, target } = getSyncFlags(direction);

  // Get all source parent IDs (active parents)
  const { data: sourceParents } = await client
    .from(parentTable)
    .select('id')
    .eq('is_published', source)
    .is('deleted_at', null)
    .limit(SUPABASE_QUERY_LIMIT);

  const sourceParentIds = new Set((sourceParents || []).map(r => r.id));

  // Get target child rows and find ones with orphaned parents
  const { data: targetChildren } = await client
    .from(tableName)
    .select('*')
    .eq('is_published', target)
    .limit(SUPABASE_QUERY_LIMIT);

  const orphanedIds = (targetChildren || [])
    .filter(row => !sourceParentIds.has((row as Record<string, unknown>)[parentColumn] as string))
    .map(row => (row as Record<string, unknown>).id as string);

  if (orphanedIds.length === 0) return 0;

  let deletedCount = 0;
  for (let i = 0; i < orphanedIds.length; i += SUPABASE_WRITE_BATCH_SIZE) {
    const batch = orphanedIds.slice(i, i + SUPABASE_WRITE_BATCH_SIZE);
    const { error } = await client
      .from(tableName)
      .delete()
      .eq('is_published', target)
      .in('id', batch);

    if (error) {
      throw new Error(`Failed to cleanup orphaned ${tableName}: ${error.message}`);
    }
    deletedCount += batch.length;
  }

  return deletedCount;
}

/**
 * Count soft-deleted draft rows that still have a published counterpart.
 * Works for any table with (id, is_published, deleted_at) columns.
 */
export async function getDeletedDraftCount(tableName: string): Promise<number> {
  const client = await getSupabaseAdmin();
  if (!client) throw new Error('Supabase not configured');

  const tenantId = await resolveEffectiveTenantId();

  let draftQuery = client
    .from(tableName)
    .select('id')
    .eq('is_published', false)
    .not('deleted_at', 'is', null)
    .limit(SUPABASE_QUERY_LIMIT);
  draftQuery = applyTenantEq(draftQuery, tenantId);
  const { data: deletedDrafts, error: draftError } = await draftQuery;

  if (draftError) {
    throw new Error(`Failed to fetch deleted drafts from ${tableName}: ${draftError.message}`);
  }

  if (!deletedDrafts || deletedDrafts.length === 0) return 0;

  let pubQuery = client
    .from(tableName)
    .select('id', { count: 'exact', head: true })
    .in('id', deletedDrafts.map(d => d.id))
    .eq('is_published', true);
  pubQuery = applyTenantEq(pubQuery, tenantId);
  const { count, error: pubError } = await pubQuery;

  if (pubError) {
    throw new Error(`Failed to count published rows pending deletion in ${tableName}: ${pubError.message}`);
  }

  return count ?? 0;
}
