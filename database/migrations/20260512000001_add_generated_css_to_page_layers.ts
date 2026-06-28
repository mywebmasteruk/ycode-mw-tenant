import type { Knex } from 'knex';

/**
 * Migration: Add generated_css column to page_layers
 *
 * Stores per-page CSS generated from each page's layer tree + resolved
 * components. Enables selective cache invalidation by making CSS changes
 * page-scoped rather than global.
 */

export async function up(knex: Knex): Promise<void> {
  // Idempotent: the column may already exist on envs where it was applied
  // out-of-band (e.g. via the Management API when the in-app runner couldn't
  // reach the DB), so `migrate:latest` reconciles cleanly instead of erroring.
  const hasColumn = await knex.schema.hasColumn('page_layers', 'generated_css');
  if (!hasColumn) {
    await knex.schema.alterTable('page_layers', (table) => {
      table.text('generated_css').nullable();
    });
  }
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('page_layers', (table) => {
    table.dropColumn('generated_css');
  });
}
