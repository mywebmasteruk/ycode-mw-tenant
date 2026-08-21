import { Knex } from 'knex';

/**
 * Close the anonymous cross-tenant read on published content.
 *
 * ## The bug
 *
 * Thirteen tenant tables carry a PERMISSIVE `tenant_select` policy granted to
 * `public` whose first branch is not tenant-scoped:
 *
 *   (auth.uid() IS NULL AND is_published AND deleted_at IS NULL)
 *   OR (auth.uid() IS NOT NULL AND tenant_id = jwt_tenant_id())
 *
 * The second branch is correct. The first is not: with no JWT, it grants every
 * published row of EVERY tenant. `translations` and `global_variables` have the
 * same shape via their own `*_anon_published` policies.
 *
 * Each table also has a `*_deny_anon` policy with `USING (false)` that looks like
 * it prevents this. It does not. Those policies are PERMISSIVE, and permissive
 * policies are OR-combined, so `false OR tenant_select` reduces to `tenant_select`
 * and the deny is a no-op. Only RESTRICTIVE policies are AND-combined.
 *
 * Measured on production before this migration, querying as `SET ROLE anon` with
 * no JWT: 9,391 collection_item_values / 1,324 assets / 1,263 collection_items
 * readable across 5 distinct tenants. The publishable key is shipped to browsers
 * by design, so assuming `anon` requires no privileged access.
 *
 * ## The fix
 *
 * Add a RESTRICTIVE deny for the `anon` role on each affected table. Restrictive
 * policies AND-combine with the permissive set, so the unscoped branch can no
 * longer grant anything, while the authenticated tenant-scoped branch is
 * untouched.
 *
 * ## Why this does not break the public site
 *
 * Nothing in the application reads tenant tables as `anon`:
 *   - `lib/page-fetcher.ts` (public renderer) uses `getSupabaseAdmin()`, which is
 *     the service_role client (`rolbypassrls`, so policies never apply) or, with
 *     MW_TENANT_RLS_ENFORCE on, a JWT minted with `role: 'authenticated'` and a
 *     non-null `sub` — the tenant-scoped branch either way.
 *   - `lib/tenant/tenant-registry-lookup.ts` uses the service key.
 *   - `lib/masjidweb/supabase-builder-session.ts` uses the anon key only for
 *     GoTrue auth, not for table reads.
 *
 * `settings` and `color_variables` already lack an anon branch and are excluded;
 * they read 0 rows as `anon` today, which is the behaviour being generalised here.
 *
 * `layer_styles`, `locales`, and `translations` currently read 0 rows only because
 * nothing is published yet — their policies still permit it, so they are included.
 */

/** Tables with an anon-reachable PERMISSIVE branch that is not tenant-scoped. */
const ANON_LEAKING_TABLES = [
  'asset_folders',
  'assets',
  'collection_fields',
  'collection_item_values',
  'collection_items',
  'collections',
  'components',
  'fonts',
  'global_variables',
  'layer_styles',
  'locales',
  'page_folders',
  'page_layers',
  'pages',
  'translations',
] as const;

const policyName = (table: string): string => `${table}_anon_restrict`;

export async function up(knex: Knex): Promise<void> {
  for (const table of ANON_LEAKING_TABLES) {
    const exists = await knex.schema.hasTable(table);
    if (!exists) continue;

    // Idempotent: drop-then-create so re-running (including on freshly imported
    // template data) converges instead of erroring on a duplicate policy.
    // Identifiers are compile-time constants from ANON_LEAKING_TABLES, and DDL
    // does not accept parameter bindings for them.
    await knex.raw(`DROP POLICY IF EXISTS "${policyName(table)}" ON public."${table}"`);
    await knex.raw(
      `CREATE POLICY "${policyName(table)}" ON public."${table}" ` +
        `AS RESTRICTIVE FOR ALL TO anon USING (false) WITH CHECK (false)`,
    );
  }
}

export async function down(knex: Knex): Promise<void> {
  for (const table of ANON_LEAKING_TABLES) {
    const exists = await knex.schema.hasTable(table);
    if (!exists) continue;
    await knex.raw(`DROP POLICY IF EXISTS "${policyName(table)}" ON public."${table}"`);
  }
}
