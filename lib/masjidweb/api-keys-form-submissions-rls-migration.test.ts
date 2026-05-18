import { describe, expect, it } from 'vitest';
import { up, down } from '@/database/migrations/20260518000002_tenant_scope_api_keys_form_submissions_rls';

type RawCall = string;

function createKnexRecorder() {
  const rawCalls: RawCall[] = [];
  return {
    knex: {
      schema: {
        raw: async (sql: string) => {
          rawCalls.push(sql.replace(/\s+/g, ' ').trim());
        },
      },
    },
    rawCalls,
  };
}

describe('api keys and form submissions RLS migration', () => {
  it('replaces broad policies with tenant-aware policies using app_metadata tenant_id', async () => {
    const { knex, rawCalls } = createKnexRecorder();

    await up(knex as never);
    const sql = rawCalls.join(' ');

    expect(sql).toContain('DROP POLICY IF EXISTS "Authenticated users can manage api_keys" ON api_keys');
    expect(sql).toContain('DROP POLICY IF EXISTS "Authenticated users can view form submissions" ON form_submissions');
    expect(sql).toContain('CREATE POLICY "Tenant users can view api_keys"');
    expect(sql).toContain('CREATE POLICY "Tenant users can view form submissions"');
    expect(sql).toContain("auth.jwt() -> 'app_metadata' ->> 'tenant_id'");
    expect(sql).not.toContain("auth.jwt() -> 'user_metadata' ->> 'tenant_id'");
  });

  it('keeps tenant_id null legacy rows readable during rollout', async () => {
    const { knex, rawCalls } = createKnexRecorder();

    await up(knex as never);
    const sql = rawCalls.join(' ');

    expect(sql).toContain('tenant_id IS NULL OR tenant_id::text =');
  });

  it('prevents direct anonymous inserts from forging tenant-owned form submissions', async () => {
    const { knex, rawCalls } = createKnexRecorder();

    await up(knex as never);
    const sql = rawCalls.join(' ');

    expect(sql).toContain('CREATE POLICY "Anyone can create legacy form submissions"');
    expect(sql).toContain("WITH CHECK (status = 'new' AND tenant_id IS NULL)");
  });

  it('restores the original broad policies in down migration', async () => {
    const { knex, rawCalls } = createKnexRecorder();

    await down(knex as never);
    const sql = rawCalls.join(' ');

    expect(sql).toContain('CREATE POLICY "Authenticated users can manage api_keys"');
    expect(sql).toContain('ON api_keys FOR ALL');
    expect(sql).toContain('CREATE POLICY "Anyone can create form submissions"');
    expect(sql).toContain("WITH CHECK (status = 'new')");
  });
});
