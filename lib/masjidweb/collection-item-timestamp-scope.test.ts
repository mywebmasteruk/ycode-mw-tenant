import { describe, expect, it } from 'vitest';
import { scopeCollectionItemTimestampUpdate } from '@/lib/masjidweb/collection-item-timestamp-scope';

type QueryCall = ['eq', string, string] | ['in', string, boolean[]];

function createQueryRecorder() {
  const calls: QueryCall[] = [];
  const query = {
    eq(column: string, value: string) {
      calls.push(['eq', column, value]);
      return query;
    },
    in(column: string, value: boolean[]) {
      calls.push(['in', column, value]);
      return query;
    },
  };

  return { calls, query };
}

describe('scopeCollectionItemTimestampUpdate', () => {
  it('filters timestamp updates by item id, published states, and tenant id', () => {
    const { calls, query } = createQueryRecorder();

    expect(scopeCollectionItemTimestampUpdate(query, 'item-1', 'tenant-1')).toBe(query);
    expect(calls).toEqual([
      ['eq', 'id', 'item-1'],
      ['in', 'is_published', [true, false]],
      ['eq', 'tenant_id', 'tenant-1'],
    ]);
  });

  it('preserves backward-compatible behavior when no tenant id is available', () => {
    const { calls, query } = createQueryRecorder();

    expect(scopeCollectionItemTimestampUpdate(query, 'item-1', null)).toBe(query);
    expect(calls).toEqual([
      ['eq', 'id', 'item-1'],
      ['in', 'is_published', [true, false]],
    ]);
  });
});
