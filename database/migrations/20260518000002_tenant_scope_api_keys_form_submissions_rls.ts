import type { Knex } from 'knex';

const tenantIdFromJwtSql = "auth.jwt() -> 'app_metadata' ->> 'tenant_id'";
const authenticatedTenantOrLegacySql = `
  (SELECT auth.uid()) IS NOT NULL
  AND (
    tenant_id IS NULL
    OR tenant_id::text = ${tenantIdFromJwtSql}
  )
`;

export async function up(knex: Knex): Promise<void> {
  await knex.schema.raw('DROP POLICY IF EXISTS "Authenticated users can manage api_keys" ON api_keys');
  await knex.schema.raw('DROP POLICY IF EXISTS "Anyone can create form submissions" ON form_submissions');
  await knex.schema.raw('DROP POLICY IF EXISTS "Authenticated users can view form submissions" ON form_submissions');
  await knex.schema.raw('DROP POLICY IF EXISTS "Authenticated users can update form submissions" ON form_submissions');
  await knex.schema.raw('DROP POLICY IF EXISTS "Authenticated users can delete form submissions" ON form_submissions');
  await knex.schema.raw('DROP POLICY IF EXISTS tenant_insert ON form_submissions');
  await knex.schema.raw('DROP POLICY IF EXISTS tenant_select ON form_submissions');
  await knex.schema.raw('DROP POLICY IF EXISTS tenant_update ON form_submissions');
  await knex.schema.raw('DROP POLICY IF EXISTS tenant_delete ON form_submissions');

  await knex.schema.raw(`
    CREATE POLICY "Tenant users can view api_keys"
      ON api_keys FOR SELECT
      USING (${authenticatedTenantOrLegacySql})
  `);

  await knex.schema.raw(`
    CREATE POLICY "Tenant users can create api_keys"
      ON api_keys FOR INSERT
      WITH CHECK (${authenticatedTenantOrLegacySql})
  `);

  await knex.schema.raw(`
    CREATE POLICY "Tenant users can update api_keys"
      ON api_keys FOR UPDATE
      USING (${authenticatedTenantOrLegacySql})
      WITH CHECK (${authenticatedTenantOrLegacySql})
  `);

  await knex.schema.raw(`
    CREATE POLICY "Tenant users can delete api_keys"
      ON api_keys FOR DELETE
      USING (${authenticatedTenantOrLegacySql})
  `);

  await knex.schema.raw(`
    CREATE POLICY "Anyone can create legacy form submissions"
      ON form_submissions FOR INSERT
      WITH CHECK (status = 'new' AND tenant_id IS NULL)
  `);

  await knex.schema.raw(`
    CREATE POLICY "Tenant users can view form submissions"
      ON form_submissions FOR SELECT
      USING (${authenticatedTenantOrLegacySql})
  `);

  await knex.schema.raw(`
    CREATE POLICY "Tenant users can update form submissions"
      ON form_submissions FOR UPDATE
      USING (${authenticatedTenantOrLegacySql})
      WITH CHECK (${authenticatedTenantOrLegacySql})
  `);

  await knex.schema.raw(`
    CREATE POLICY "Tenant users can delete form submissions"
      ON form_submissions FOR DELETE
      USING (${authenticatedTenantOrLegacySql})
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.raw('DROP POLICY IF EXISTS "Tenant users can view api_keys" ON api_keys');
  await knex.schema.raw('DROP POLICY IF EXISTS "Tenant users can create api_keys" ON api_keys');
  await knex.schema.raw('DROP POLICY IF EXISTS "Tenant users can update api_keys" ON api_keys');
  await knex.schema.raw('DROP POLICY IF EXISTS "Tenant users can delete api_keys" ON api_keys');
  await knex.schema.raw('DROP POLICY IF EXISTS "Anyone can create legacy form submissions" ON form_submissions');
  await knex.schema.raw('DROP POLICY IF EXISTS "Tenant users can view form submissions" ON form_submissions');
  await knex.schema.raw('DROP POLICY IF EXISTS "Tenant users can update form submissions" ON form_submissions');
  await knex.schema.raw('DROP POLICY IF EXISTS "Tenant users can delete form submissions" ON form_submissions');

  await knex.schema.raw(`
    CREATE POLICY "Authenticated users can manage api_keys"
      ON api_keys FOR ALL
      USING ((SELECT auth.uid()) IS NOT NULL)
  `);

  await knex.schema.raw(`
    CREATE POLICY "Anyone can create form submissions"
      ON form_submissions FOR INSERT
      WITH CHECK (status = 'new')
  `);

  await knex.schema.raw(`
    CREATE POLICY "Authenticated users can view form submissions"
      ON form_submissions FOR SELECT
      USING ((SELECT auth.uid()) IS NOT NULL)
  `);

  await knex.schema.raw(`
    CREATE POLICY "Authenticated users can update form submissions"
      ON form_submissions FOR UPDATE
      USING ((SELECT auth.uid()) IS NOT NULL)
  `);

  await knex.schema.raw(`
    CREATE POLICY "Authenticated users can delete form submissions"
      ON form_submissions FOR DELETE
      USING ((SELECT auth.uid()) IS NOT NULL)
  `);
}
