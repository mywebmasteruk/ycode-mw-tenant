/**
 * Multi-tenant boundary module.
 *
 * All tenant-specific customizations (subdomain resolution, tenant scoping,
 * RLS helpers) live here. Upstream YCode code should import from this module
 * rather than scattering tenant logic across the codebase.
 *
 * Files in this module:
 * - middleware-utils.ts — pure functions for subdomain extraction, public API
 *   route detection, used by `proxy.ts` (and root middleware when restored)
 *
 * Related files outside this module (tightly coupled to Supabase/Knex):
 * - lib/supabase-server.ts — getTenantIdFromHeaders(), scopeToTenantRow() (when restored)
 * - lib/knex-helpers.ts — addTenantFilter(), batchUpdateColumn(), incrementColumn()
 */

export {
  extractSubdomain,
  isPublicApiRoute,
  isProtectedSiteApiRoute,
  getSupabaseEnvConfig,
  isPublicPage,
} from './middleware-utils';
