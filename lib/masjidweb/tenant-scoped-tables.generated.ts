// MASJIDWEB_SEAM: schema-driven-isolation — see docs/masjidweb-core-seams.md#tier-0
//
// GENERATED FILE — do not edit by hand.
//
// Source of truth: the LIVE production schema (every public table that has a
// `tenant_id` column). Regenerate after a Ycode core update adds/removes a
// tenant-scoped table:
//
//     SUPABASE_ACCESS_TOKEN=<pat> npx tsx scripts/core-update/generate-tenant-scoped-tables.ts
//
// The static tenant-isolation gate (tenant-isolation-gate.ts) requires every
// `client.from('<TENANT_SCOPED_TABLE>')` query to be tenant-scoped. Because this
// list is derived from the schema (not hand-curated), a new tenant_id table is
// auto-required to be scoped once this file is regenerated — no manual Set edit.
// The Phase 2 dashboard tripwire (mw_unclassified_tables) flags the new table so
// you know to regenerate.
//
// Content is purely schema-determined (sorted), so regenerating is a no-op diff
// unless the schema actually changed. GLOBAL_TABLES are listed for
// completeness/auditing; the gate ignores them (no tenant_id, genuinely
// cross-tenant/system).

/** Public tables that have a `tenant_id` column and MUST be tenant-scoped. */
export const TENANT_SCOPED_TABLES: ReadonlySet<string> = new Set([
  'api_keys',
  'app_settings',
  'asset_folders',
  'assets',
  'collection_fields',
  'collection_imports',
  'collection_item_values',
  'collection_items',
  'collections',
  'color_variables',
  'components',
  'fonts',
  'form_submissions',
  'global_variables',
  'layer_styles',
  'locales',
  'mcp_tokens',
  'page_folders',
  'page_layers',
  'pages',
  'provisioning_audit_log',
  'settings',
  'tenant_homepage_content',
  'translations',
  'versions',
  'webhook_deliveries',
  'webhooks',
]);

/** Public tables with NO `tenant_id` column (genuinely global / system / platform). */
export const GLOBAL_TABLES: ReadonlySet<string> = new Set([
  'admin_ai_provider_settings',
  'core_update_audit_log',
  'mcp_oauth_clients',
  'mcp_oauth_codes',
  'migrations',
  'mw_table_policy',
  'tenant_isolation_check_log',
  'tenant_registry',
]);
