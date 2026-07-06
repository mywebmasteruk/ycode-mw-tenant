import type { Knex } from 'knex';

/**
 * Migration: mw_rls_coverage() — RLS schema-coverage report for the daily
 * isolation canary.
 *
 * With MW_SEAMS_RETIRED on, applyTenantEq skips its app-layer tenant filter for
 * queries built by the RLS-enforced tenant client, so isolation rides on every
 * tenant table (= every public table with a tenant_id column) having row-level
 * security enabled with tenant-scoped policies. A NEW upstream table that ships
 * without RLS would be fail-OPEN for the authenticated-role client while the
 * app filter is skipped — and nothing asserted schema coverage until now.
 *
 * This function reports, per tenant table:
 *   - rls_enabled / rls_forced          (pg_class)
 *   - tenant_policies                    policies whose USING/WITH CHECK mention
 *                                        tenant (current_tenant_id() etc.)
 *   - leaky_policies                     PERMISSIVE policies for authenticated/
 *                                        PUBLIC whose expressions are NOT
 *                                        tenant-scoped and can match rows (not
 *                                        the literal 'false' deny policies).
 *                                        Permissive policies OR-combine, so one
 *                                        of these NEGATES every tenant policy on
 *                                        the table (the exact leak class the
 *                                        2026-06 RLS rollout had to drop).
 *                                        anon-only policies are excluded: the
 *                                        minted tenant JWT uses role
 *                                        authenticated, and the anon
 *                                        read-published policies are deliberate.
 *
 * Callable ONLY by service_role (the daily canary's key). SECURITY INVOKER —
 * service_role can read pg_catalog directly; no privilege escalation. Read-only.
 * Consumed by scripts/tenant-isolation-live-check.ts ("RLS schema coverage").
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.raw(`
    CREATE OR REPLACE FUNCTION public.mw_rls_coverage()
    RETURNS TABLE(
      table_name text,
      rls_enabled boolean,
      rls_forced boolean,
      tenant_policies integer,
      leaky_policies integer
    )
    LANGUAGE sql
    STABLE
    SET search_path = pg_catalog, public
    AS $fn$
      SELECT
        c.relname::text,
        c.relrowsecurity,
        c.relforcerowsecurity,
        (
          SELECT count(*)::int FROM pg_policy p
          WHERE p.polrelid = c.oid
            AND (
              coalesce(pg_get_expr(p.polqual, p.polrelid), '') ILIKE '%tenant%'
              OR coalesce(pg_get_expr(p.polwithcheck, p.polrelid), '') ILIKE '%tenant%'
            )
        ),
        (
          SELECT count(*)::int FROM pg_policy p
          WHERE p.polrelid = c.oid
            AND p.polpermissive
            AND coalesce(pg_get_expr(p.polqual, p.polrelid), '') NOT ILIKE '%tenant%'
            AND coalesce(pg_get_expr(p.polwithcheck, p.polrelid), '') NOT ILIKE '%tenant%'
            AND NOT (
              coalesce(pg_get_expr(p.polqual, p.polrelid), 'false') = 'false'
              AND coalesce(pg_get_expr(p.polwithcheck, p.polrelid), 'false') = 'false'
            )
            AND (
              p.polroles = '{0}'::oid[]
              OR EXISTS (
                SELECT 1 FROM pg_roles r
                WHERE r.oid = ANY (p.polroles) AND r.rolname = 'authenticated'
              )
            )
        )
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public'
        AND c.relkind = 'r'
        AND EXISTS (
          SELECT 1 FROM pg_attribute a
          WHERE a.attrelid = c.oid AND a.attname = 'tenant_id' AND NOT a.attisdropped
        )
      ORDER BY 1
    $fn$;
  `);
  await knex.schema.raw('REVOKE ALL ON FUNCTION public.mw_rls_coverage() FROM PUBLIC');
  await knex.schema.raw('REVOKE ALL ON FUNCTION public.mw_rls_coverage() FROM anon');
  await knex.schema.raw('REVOKE ALL ON FUNCTION public.mw_rls_coverage() FROM authenticated');
  await knex.schema.raw('GRANT EXECUTE ON FUNCTION public.mw_rls_coverage() TO service_role');
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.raw('DROP FUNCTION IF EXISTS public.mw_rls_coverage()');
}
