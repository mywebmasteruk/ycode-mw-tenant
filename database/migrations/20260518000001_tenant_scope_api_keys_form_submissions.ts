import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  const apiKeysHasTenantId = await knex.schema.hasColumn('api_keys', 'tenant_id');
  if (!apiKeysHasTenantId) {
    await knex.schema.alterTable('api_keys', (table) => {
      table.uuid('tenant_id').nullable();
    });
  }

  const formSubmissionsHasTenantId = await knex.schema.hasColumn('form_submissions', 'tenant_id');
  if (!formSubmissionsHasTenantId) {
    await knex.schema.alterTable('form_submissions', (table) => {
      table.uuid('tenant_id').nullable();
    });
  }

  await knex.schema.raw(`
    CREATE INDEX IF NOT EXISTS idx_api_keys_tenant_id
    ON api_keys(tenant_id)
  `);

  await knex.schema.raw(`
    CREATE INDEX IF NOT EXISTS idx_api_keys_tenant_hash
    ON api_keys(tenant_id, key_hash)
  `);

  await knex.schema.raw(`
    CREATE INDEX IF NOT EXISTS idx_form_submissions_tenant_id
    ON form_submissions(tenant_id)
  `);

  await knex.schema.raw(`
    CREATE INDEX IF NOT EXISTS idx_form_submissions_tenant_form_created
    ON form_submissions(tenant_id, form_id, created_at DESC)
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.raw('DROP INDEX IF EXISTS idx_form_submissions_tenant_form_created');
  await knex.schema.raw('DROP INDEX IF EXISTS idx_form_submissions_tenant_id');
  await knex.schema.raw('DROP INDEX IF EXISTS idx_api_keys_tenant_hash');
  await knex.schema.raw('DROP INDEX IF EXISTS idx_api_keys_tenant_id');

  const formSubmissionsHasTenantId = await knex.schema.hasColumn('form_submissions', 'tenant_id');
  if (formSubmissionsHasTenantId) {
    await knex.schema.alterTable('form_submissions', (table) => {
      table.dropColumn('tenant_id');
    });
  }

  const apiKeysHasTenantId = await knex.schema.hasColumn('api_keys', 'tenant_id');
  if (apiKeysHasTenantId) {
    await knex.schema.alterTable('api_keys', (table) => {
      table.dropColumn('tenant_id');
    });
  }
}
