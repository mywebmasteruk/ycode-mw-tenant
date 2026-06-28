import type { Knex } from 'knex';

/**
 * Migration: tenant-scope global_variables
 *
 * global_variables arrived as a new upstream feature (20260611000001) without a
 * tenant_id column, so on the multi-tenant fork every tenant's site read every
 * other tenant's globals through the service-role client. Add the tenant_id
 * column + index so globalVariableRepository can scope reads/writes via
 * applyTenantEq / tenant_id, matching the other 17 core tables and the
 * api_keys/form_submissions precedent (20260518000001).
 *
 * Nullable to stay compatible with the legacy/single-tenant path (applyTenantEq
 * leaves a null tenant unscoped); new rows are stamped with the effective tenant
 * by the repository. The table is new, so there is no cross-tenant data to
 * backfill.
 */
export async function up(knex: Knex): Promise<void> {
  const hasTable = await knex.schema.hasTable('global_variables');
  if (!hasTable) {
    return;
  }

  const hasTenantId = await knex.schema.hasColumn('global_variables', 'tenant_id');
  if (!hasTenantId) {
    await knex.schema.alterTable('global_variables', (table) => {
      table.uuid('tenant_id').nullable();
    });
  }

  await knex.schema.raw(`
    CREATE INDEX IF NOT EXISTS idx_global_variables_tenant_id
    ON global_variables(tenant_id)
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.raw('DROP INDEX IF EXISTS idx_global_variables_tenant_id');

  const hasTenantId = await knex.schema.hasColumn('global_variables', 'tenant_id');
  if (hasTenantId) {
    await knex.schema.alterTable('global_variables', (table) => {
      table.dropColumn('tenant_id');
    });
  }
}
