/**
 * Resolve tenant id/slug from tenant_registry via Supabase REST (service role).
 * Used by proxy.ts.
 *
 * ## Short-lived in-memory cache (per serverless instance)
 * Reduces Supabase round-trips on hot paths. Defaults are intentionally **short**
 * so we do not repeat the old bug: caching slug→id for ~60s after **reclaim +
 * reprovision** left the same slug pointing at a **new** `tenant_registry.id`,
 * so the builder loaded an **empty** tenant until the cache expired.
 *
 * - **Success entries** (tenant found): default **30s** (`TENANT_LOOKUP_CACHE_SUCCESS_MS`).
 * - **Miss entries** (no row): default **2s** (`TENANT_LOOKUP_CACHE_MISS_MS`) — avoids
 *   hammering Supabase on typos while a **new** tenant becomes visible quickly.
 * - **`bypassCache: true`**: used for provisioning publish — always hits Supabase so
 *   `x-tenant-id` is never read from a stale entry during that flow.
 * - Set `TENANT_LOOKUP_CACHE_SUCCESS_MS=0` to disable caching entirely.
 *
 * This cache does **not** affect published HTML freshness (`Cache-Control`, tags,
 * `revalidateTag`); it only speeds up **which tenant id** is attached to a subdomain.
 */

import { getSupabaseEnvConfig } from '@/lib/tenant/middleware-utils';

export type LookupTenantOptions = {
  /** When true, skip read/write cache (provisioning publish and similar). */
  bypassCache?: boolean;
};

type CacheEntry = {
  value: { id: string; slug: string } | null;
  expiresAt: number;
};

const cache = new Map<string, CacheEntry>();

/** Clears the lookup cache (for tests only). */
export function clearTenantLookupCacheForTests(): void {
  cache.clear();
}

function successTtlMs(): number {
  const raw = process.env.TENANT_LOOKUP_CACHE_SUCCESS_MS?.trim();
  if (raw === '0') return 0;
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) && n >= 0 ? n : 30000;
}

function missTtlMs(): number {
  const raw = process.env.TENANT_LOOKUP_CACHE_MISS_MS?.trim();
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) && n >= 0 ? n : 2000;
}

function normalizeSlug(slug: string): string {
  return slug.trim().toLowerCase();
}

async function fetchTenantFromSupabase(
  slug: string,
): Promise<{ id: string; slug: string } | null> {
  const envConfig = getSupabaseEnvConfig();
  const key =
    process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!envConfig || !key) return null;
  const url = envConfig.url;

  try {
    const qs = new URLSearchParams({
      slug: `eq.${slug}`,
      status: 'in.(active,provisioning)',
      select: 'id,slug',
      limit: '1',
    });
    const res = await fetch(`${url}/rest/v1/tenant_registry?${qs}`, {
      headers: { apikey: key, Authorization: `Bearer ${key}` },
    });
    if (!res.ok) return null;
    const rows = (await res.json()) as { id: string; slug: string }[];
    if (!rows.length) return null;
    return rows[0];
  } catch {
    return null;
  }
}

export async function lookupTenant(
  slug: string,
  opts?: LookupTenantOptions,
): Promise<{ id: string; slug: string } | null> {
  const normalized = normalizeSlug(slug);
  if (!normalized) return null;

  const bypass = opts?.bypassCache === true;
  const successTtl = successTtlMs();
  const missTtl = missTtlMs();

  if (!bypass && successTtl > 0) {
    const hit = cache.get(normalized);
    if (hit && hit.expiresAt > Date.now()) {
      return hit.value;
    }
  }

  const fresh = await fetchTenantFromSupabase(normalized);

  if (!bypass) {
    const ttl = fresh ? successTtl : missTtl;
    if (ttl > 0) {
      cache.set(normalized, {
        value: fresh,
        expiresAt: Date.now() + ttl,
      });
    }
  }

  return fresh;
}
