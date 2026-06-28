import type { Knex } from 'knex';

/**
 * Migration: tenant-scope the app_settings uniqueness.
 *
 * app_settings stores per-tenant integration config (API keys, connections).
 * The original schema had a GLOBAL unique on (app_id, key), which let one
 * tenant's upsert overwrite another tenant's row and made reads collide across
 * tenants. Replace it with a tenant-scoped unique on (tenant_id, app_id, key),
 * matching the `app_settings_tenant_app_key_uq` index already present on prod.
 *
 * Pairs with the tenant scoping added to appSettingsRepository (applyTenantEq on
 * reads, tenant_id in the upsert payload, onConflict: 'tenant_id,app_id,key').
 *
 * SAFETY: idempotent + non-destructive. Template apply (runPendingMigrations
 * ForTemplate) re-runs up() directly, bypassing knex's applied-migrations
 * tracking, so up() must be safe to run repeatedly and must never drop data.
 */
export async function up(knex: Knex): Promise<void> {
  const hasTable = await knex.schema.hasTable('app_settings');
  if (!hasTable) return;

  const hasTenantId = await knex.schema.hasColumn('app_settings', 'tenant_id');
  if (!hasTenantId) {
    await knex.schema.alterTable('app_settings', (table) => {
      table.uuid('tenant_id').nullable();
    });
  }

  // Drop the legacy global unique on (app_id, key) if a repo-provisioned DB has
  // it (knex's table.unique created it as a constraint; some envs as an index).
  await knex.raw('ALTER TABLE app_settings DROP CONSTRAINT IF EXISTS app_settings_app_id_key_unique');
  await knex.raw('DROP INDEX IF EXISTS app_settings_app_id_key_unique');

  // Tenant-scoped unique. IF NOT EXISTS → no-op where prod already has it.
  await knex.raw(
    'CREATE UNIQUE INDEX IF NOT EXISTS app_settings_tenant_app_key_uq ON app_settings (tenant_id, app_id, key)',
  );
  await knex.raw('CREATE INDEX IF NOT EXISTS idx_app_settings_tenant_id ON app_settings(tenant_id)');
}

export async function down(knex: Knex): Promise<void> {
  const hasTable = await knex.schema.hasTable('app_settings');
  if (!hasTable) return;
  await knex.raw('DROP INDEX IF EXISTS app_settings_tenant_app_key_uq');
  await knex.raw('DROP INDEX IF EXISTS idx_app_settings_tenant_id');
  // Restore the original global unique on (app_id, key).
  await knex.raw(
    'CREATE UNIQUE INDEX IF NOT EXISTS app_settings_app_id_key_unique ON app_settings (app_id, key)',
  );
}
