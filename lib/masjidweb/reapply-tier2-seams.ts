/**
 * Mechanical tier-2 repository merge: upstream Ycode + MasjidWeb tenant seams from main.
 * See docs/masjidweb-core-seams.md (Tier 2 — Repository pattern).
 */
import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const TIER2_SEAM_FILES = [
  'lib/repositories/collectionFieldRepository.ts',
  'lib/repositories/collectionRepository.ts',
  'lib/repositories/collectionItemRepository.ts',
  'lib/repositories/layerStyleRepository.ts',
  'lib/repositories/pageLayersRepository.ts',
] as const;

export type Tier2SeamFile = (typeof TIER2_SEAM_FILES)[number];

export interface ReapplyTier2Options {
  repoRoot: string;
  /** Only re-apply these paths (must be subset of TIER2_SEAM_FILES). */
  files?: Tier2SeamFile[];
  /** Ref for MasjidWeb tenant seams (default main). */
  oursRef?: string;
  /** Ref for upstream Ycode (default upstream/main). */
  theirsRef?: string;
}

function run(command: string, repoRoot: string): string {
  return execSync(command, { encoding: 'utf8', cwd: repoRoot }).trim();
}

function runAllowFailure(command: string, repoRoot: string): boolean {
  try {
    execSync(command, { encoding: 'utf8', cwd: repoRoot, stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

export function ensureUpstreamFetched(repoRoot: string): void {
  if (runAllowFailure('git rev-parse --verify upstream/main', repoRoot)) {
    return;
  }
  runAllowFailure(
    'git remote add upstream https://github.com/ycode/ycode.git',
    repoRoot,
  );
  run('git fetch upstream main', repoRoot);
}

function gitShow(ref: string, path: string, repoRoot: string): string {
  return execSync(`git show ${ref}:${path}`, {
    encoding: 'utf8',
    cwd: repoRoot,
  });
}

function mergeImports(ours: string, theirs: string): string {
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const block of [ours, theirs]) {
    for (const line of block.split('\n')) {
      if (line.trim().startsWith('import ') && !seen.has(line)) {
        seen.add(line);
        lines.push(line);
      }
    }
  }
  lines.sort((a, b) => {
    const score = (s: string) =>
      s.includes('masjidweb') ? 0 : s.includes('supabase-server') ? 1 : 2;
    return score(a) - score(b) || a.localeCompare(b);
  });
  return lines.join('\n');
}

function resolveImportConflicts(content: string): string {
  const pattern =
    /<<<<<<<[^\n]*\n([\s\S]*?)=======\n([\s\S]*?)>>>>>>>[^\n]*\n/g;
  return content.replace(pattern, (full, ours, theirs) => {
    const oursImports = ours.trim();
    const theirsImports = theirs.trim();
    if (
      !oursImports.includes('import ') ||
      !theirsImports.includes('import ')
    ) {
      return full;
    }
    return `${mergeImports(oursImports, theirsImports)}\n`;
  });
}

function dedupeSupabaseImports(content: string): string {
  const lines = content.split('\n');
  let sawSupabaseImport = false;
  return lines
    .filter((line) => {
      if (!line.includes("from '@/lib/supabase-server'")) return true;
      if (line.trim().startsWith('import ') && line.includes('getSupabaseAdmin')) {
        if (sawSupabaseImport) return false;
        sawSupabaseImport = true;
      }
      return true;
    })
    .join('\n');
}

function dedupeValueRepoImports(content: string): string {
  const pattern =
    /import \{ getValuesByFieldId, getValuesByItemIds, getValuesByItemId(?:, getValueRowsForItems)? \} from '@\/lib\/repositories\/collectionItemValueRepository';\n/g;
  const matches = content.match(pattern);
  if (!matches || matches.length < 2) return content;
  const keep =
    "import { getValuesByFieldId, getValuesByItemIds, getValuesByItemId, getValueRowsForItems } from '@/lib/repositories/collectionItemValueRepository';\n";
  let replaced = false;
  return content.replace(pattern, () => {
    if (replaced) return '';
    replaced = true;
    return keep;
  });
}

function fixTenantIdShadowing(content: string): string {
  let out = content;
  if (out.includes('tenantId?: string')) {
    out = out.replace(
      /const tenantId = await resolveEffectiveTenantId\(\);/g,
      'const effectiveTenantId = await resolveEffectiveTenantId();',
    );
    out = out.replace(
      /if \(tenantId\) \{\s*\n\s*(\w+) = \1\.eq\('tenant_id', tenantId\);/g,
      "if (effectiveTenantId) {\n      $1 = $1.eq('tenant_id', effectiveTenantId);",
    );
    out = out.replace(
      /if \(tenantId\) \{\s*\n\s*insertRow\.tenant_id = tenantId;/g,
      'if (effectiveTenantId) {\n    insertRow.tenant_id = effectiveTenantId;',
    );
    out = out.replace(
      /const rowTid =\s*\n\s*tenantId \?\?/g,
      'const rowTid =\n    effectiveTenantId ??',
    );
  }
  return out;
}

function threeWayMerge(
  path: string,
  mergeBase: string,
  oursRef: string,
  theirsRef: string,
  repoRoot: string,
): string {
  const ours = gitShow(oursRef, path, repoRoot);
  const base = gitShow(mergeBase, path, repoRoot);
  const theirs = gitShow(theirsRef, path, repoRoot);

  const oursPath = join(repoRoot, '.tmp-merge-ours');
  const basePath = join(repoRoot, '.tmp-merge-base');
  const theirsPath = join(repoRoot, '.tmp-merge-theirs');
  const outPath = join(repoRoot, '.tmp-merge-out');

  writeFileSync(oursPath, ours);
  writeFileSync(basePath, base);
  writeFileSync(theirsPath, theirs);

  try {
    const merged = execSync(
      `git merge-file -p "${oursPath}" "${basePath}" "${theirsPath}"`,
      { encoding: 'utf8', cwd: repoRoot, stdio: ['pipe', 'pipe', 'pipe'] },
    );
    writeFileSync(outPath, merged);
  } catch (error: unknown) {
    const err = error as { stdout?: string };
    if (typeof err.stdout === 'string' && err.stdout.length > 0) {
      writeFileSync(outPath, err.stdout);
    } else {
      throw error;
    }
  }

  return readFileSync(outPath, 'utf8');
}

function resolveCollectionItemContent(content: string): string {
  let text = resolveImportConflicts(content);
  text = dedupeSupabaseImports(text);
  text = dedupeValueRepoImports(text);

  const getAllItemsFn = text.match(
    /export async function getAllItemsByCollectionId\([\s\S]*?^}\n\n\/\*\*\n \* Get item by ID/m,
  );
  if (getAllItemsFn) {
    const replacement = `export async function getAllItemsByCollectionId(
  collection_id: string,
  is_published: boolean = false,
  includeDeleted: boolean = false
): Promise<CollectionItem[]> {
  if (!(await tenantHasCollectionAccess(collection_id))) {
    return [];
  }

  // Fast path: one direct-DB (Knex) query instead of paginated PostgREST reads.
  try {
    const knex = await getKnexClient();
    const resolvedTenantId = await getTenantIdFromHeaders();
    let query = knex('collection_items')
      .select('*')
      .where('collection_id', collection_id)
      .andWhere('is_published', is_published)
      .orderBy('manual_order', 'asc')
      .orderBy('created_at', 'desc');
    if (is_published) {
      query = query.where('is_publishable', true);
    }
    if (resolvedTenantId) {
      query = query.where('tenant_id', resolvedTenantId);
    }
    query = includeDeleted
      ? query.whereNotNull('deleted_at')
      : query.whereNull('deleted_at');
    return await query;
  } catch {
    const client = await getSupabaseAdmin();
    if (!client) {
      throw new Error('Supabase client not configured');
    }

    const effectiveTenantId = await resolveEffectiveTenantId();
    const allItems: CollectionItem[] = [];
    let offset = 0;
    let hasMore = true;

    while (hasMore) {
      let query = client
        .from('collection_items')
        .select('*')
        .eq('collection_id', collection_id)
        .eq('is_published', is_published)
        .order('manual_order', { ascending: true })
        .order('created_at', { ascending: false })
        .range(offset, offset + SUPABASE_QUERY_LIMIT - 1);

      if (is_published) {
        query = query.eq('is_publishable', true);
      }

      if (includeDeleted) {
        query = query.not('deleted_at', 'is', null);
      } else {
        query = query.is('deleted_at', null);
      }

      query = applyTenantEq(query, effectiveTenantId);

      const { data, error } = await query;

      if (error) {
        throw new Error(\`Failed to fetch collection items: \${error.message}\`);
      }

      if (data && data.length > 0) {
        allItems.push(...data);
        offset += data.length;
        hasMore = data.length === SUPABASE_QUERY_LIMIT;
      } else {
        hasMore = false;
      }
    }

    return allItems;
  }
}

/**
 * Get item by ID`;
    text = text.replace(getAllItemsFn[0], replacement);
  }

  const getItemsByIdsFn = text.match(
    /export async function getItemsByIds\([\s\S]*?^}\n\n\/\*\*\n \* Get item with all field values/m,
  );
  if (getItemsByIdsFn) {
    const replacement = `export async function getItemsByIds(ids: string[], isPublished: boolean = false, tenantId?: string): Promise<CollectionItem[]> {
  if (ids.length === 0) {
    return [];
  }

  try {
    const knex = await getKnexClient();
    const resolvedTenantId = tenantId ?? await getTenantIdFromHeaders();
    let query = knex('collection_items')
      .select('*')
      .whereIn('id', ids)
      .andWhere('is_published', isPublished)
      .whereNull('deleted_at');
    if (resolvedTenantId) {
      query = query.where('tenant_id', resolvedTenantId);
    }
    return await query;
  } catch {
    const client = await getSupabaseAdmin(tenantId);
    if (!client) {
      throw new Error('Supabase client not configured');
    }

    const effectiveTenantId = tenantId ?? await resolveEffectiveTenantId();
    const allItems: CollectionItem[] = [];
    for (let i = 0; i < ids.length; i += SUPABASE_WRITE_BATCH_SIZE) {
      const batchIds = ids.slice(i, i + SUPABASE_WRITE_BATCH_SIZE);
      let idsQ = client
        .from('collection_items')
        .select('*')
        .in('id', batchIds)
        .eq('is_published', isPublished)
        .is('deleted_at', null);

      idsQ = applyTenantEq(idsQ, effectiveTenantId);

      const { data, error } = await idsQ;

      if (error) {
        throw new Error(\`Failed to fetch collection items: \${error.message}\`);
      }
      if (data) {
        allItems.push(...data);
      }
    }
    return allItems;
  }
}

/**
 * Get item with all field values`;
    text = text.replace(getItemsByIdsFn[0], replacement);
  }

  text = text.replace(
    /<<<<<<<[^\n]*\n {4}count \+= await countItemsWithValueChanges\(client, matchingOrderItemIds, tenantId\);\n=======\n {4}const valueChanges = await countItemsWithValueChanges\(matchingOrderItemIds\);\n {4}count \+= valueChanges;\n>>>>>>>[^\n]*\n/g,
    '    const valueChanges = await countItemsWithValueChanges(matchingOrderItemIds);\n    count += valueChanges;\n',
  );

  text = text.replace(
    /<<<<<<<[^\n]*\nasync function countItemsWithValueChanges\([\s\S]*?>>>>>>>[^\n]*\n\n {2}let draftValueRows/g,
    `async function countItemsWithValueChanges(itemIds: string[]): Promise<number> {
  if (itemIds.length === 0) return 0;

  let draftValueRows`,
  );

  text = text.replace(
    /<<<<<<<[^\n]*\n {4}let dVals[\s\S]*?>>>>>>>[^\n]*\n\n {2}const groupByItem/g,
    `  try {
    [draftValueRows, publishedValueRows] = await Promise.all([
      getValueRowsForItems(itemIds, false),
      getValueRowsForItems(itemIds, true),
    ]);
  } catch {
    return 0;
  }

  const groupByItem`,
  );

  return fixTenantIdShadowing(text);
}

function resolvePageLayersContent(content: string): string {
  let text = resolveImportConflicts(content);

  const batchFn = text.match(
    /export async function batchPublishPageLayers\([\s\S]*?^}\n\n\/\*\*\n \* Get all layers entries/m,
  );
  if (!batchFn || !batchFn[0].includes('<<<<<<<')) {
    return fixTenantIdShadowing(text);
  }

  const replacement = `export async function batchPublishPageLayers(
  pageIds: string[],
  options: { force?: boolean } = {},
): Promise<{ count: number; changedPageIds: string[] }> {
  if (pageIds.length === 0) {
    return { count: 0, changedPageIds: [] };
  }

  const client = await getSupabaseAdmin();

  if (!client) {
    throw new Error('Supabase not configured');
  }

  const tenantId = await resolveEffectiveTenantId();

  let pageIdsToPublish: string[];

  if (options.force) {
    pageIdsToPublish = pageIds;
  } else {
    let draftHashesQ = client
      .from('page_layers')
      .select('id, page_id, content_hash')
      .in('page_id', pageIds)
      .eq('is_published', false)
      .is('deleted_at', null);
    draftHashesQ = applyTenantEq(draftHashesQ, tenantId);

    let publishedHashesQ = client
      .from('page_layers')
      .select('id, content_hash')
      .in('page_id', pageIds)
      .eq('is_published', true)
      .is('deleted_at', null);
    publishedHashesQ = applyTenantEq(publishedHashesQ, tenantId);

    const [draftHashes, publishedHashes] = await Promise.all([
      draftHashesQ,
      publishedHashesQ,
    ]);

    if (draftHashes.error) {
      throw new Error(\`Failed to fetch draft layer hashes: \${draftHashes.error.message}\`);
    }
    if (publishedHashes.error) {
      throw new Error(\`Failed to fetch published layer hashes: \${publishedHashes.error.message}\`);
    }

    const publishedHashById = new Map<string, string | null>(
      (publishedHashes.data || []).map(r => [r.id, r.content_hash]),
    );

    pageIdsToPublish = (draftHashes.data || [])
      .filter(d => {
        const pubHash = publishedHashById.get(d.id);
        return pubHash === undefined || pubHash !== d.content_hash;
      })
      .map(d => d.page_id);

    if (pageIdsToPublish.length === 0) {
      return { count: 0, changedPageIds: [] };
    }
  }

  const draftLayers = await getDraftLayersForPages(pageIdsToPublish);

  if (draftLayers.length === 0) {
    return { count: 0, changedPageIds: [] };
  }

  const now = new Date().toISOString();
  const layersToUpsert: Record<string, unknown>[] = draftLayers.map(draft => {
    const rowTid =
      tenantId ??
      (draft as { tenant_id?: string | null }).tenant_id ??
      undefined;

    return {
      id: draft.id,
      page_id: draft.page_id,
      layers: draft.layers,
      generated_css: draft.generated_css || null,
      content_hash: draft.content_hash,
      is_published: true,
      updated_at: now,
      ...(rowTid ? { tenant_id: rowTid } : {}),
    };
  });

  if (layersToUpsert.length > 0) {
    const { error } = await client
      .from('page_layers')
      .upsert(layersToUpsert, {
        onConflict: 'id,is_published',
      });

    if (error) {
      throw new Error(\`Failed to batch publish layers: \${error.message}\`);
    }
  }

  return {
    count: layersToUpsert.length,
    changedPageIds: [...new Set(layersToUpsert.map((l) => l.page_id as string))],
  };
}

/**
 * Get all layers entries`;

  text = text.replace(batchFn[0], replacement);
  return fixTenantIdShadowing(text);
}

function resolveLayerStyleContent(content: string): string {
  let text = resolveImportConflicts(content);
  text = text.replace(
    /<<<<<<<[^\n]*\nimport \{ updateLayersWithStyle \}[^\n]*\nimport \{ resolveEffectiveTenantId \}[^\n]*\nimport \{ applyTenantEq \}[^\n]*\n=======\nimport \{ updateLayersWithStyle, detachStyleFromLayers, getStyleIds \}[^\n]*\n>>>>>>>[^\n]*\n/g,
    "import { updateLayersWithStyle, detachStyleFromLayers, getStyleIds } from '@/lib/layer-style-utils';\nimport { resolveEffectiveTenantId } from '@/lib/masjidweb/effective-tenant-id';\nimport { applyTenantEq } from '@/lib/masjidweb/apply-tenant-eq';\n",
  );
  return fixTenantIdShadowing(text);
}

function postProcessMerged(path: string, content: string): string {
  let text = resolveImportConflicts(content);
  text = dedupeSupabaseImports(text);

  if (path === 'lib/repositories/collectionItemRepository.ts') {
    return resolveCollectionItemContent(text);
  }
  if (path === 'lib/repositories/pageLayersRepository.ts') {
    return resolvePageLayersContent(text);
  }
  if (path === 'lib/repositories/layerStyleRepository.ts') {
    return resolveLayerStyleContent(text);
  }

  return fixTenantIdShadowing(text);
}

function assertNoConflictMarkers(content: string, path: string): void {
  const count = (content.match(/^<<<<<<< /gm) ?? []).length;
  if (count > 0) {
    throw new Error(
      `${path}: ${count} unresolved conflict marker(s) after tier-2 seam re-apply`,
    );
  }
}

export function reapplyTier2Seams(options: ReapplyTier2Options): string[] {
  const repoRoot = options.repoRoot;
  const oursRef = options.oursRef ?? 'main';
  const theirsRef = options.theirsRef ?? 'upstream/main';
  const targets = (options.files ?? [...TIER2_SEAM_FILES]).filter((f) =>
    TIER2_SEAM_FILES.includes(f as Tier2SeamFile),
  ) as Tier2SeamFile[];

  ensureUpstreamFetched(repoRoot);

  const mergeBase = run(
    `git merge-base ${oursRef} ${theirsRef}`,
    repoRoot,
  );

  const updated: string[] = [];

  for (const path of targets) {
    let merged = threeWayMerge(path, mergeBase, oursRef, theirsRef, repoRoot);
    merged = postProcessMerged(path, merged);
    assertNoConflictMarkers(merged, path);
    writeFileSync(join(repoRoot, path), merged.endsWith('\n') ? merged : `${merged}\n`);
    updated.push(path);
    console.log(`Tier-2 seam re-apply OK: ${path}`);
  }

  return updated;
}
