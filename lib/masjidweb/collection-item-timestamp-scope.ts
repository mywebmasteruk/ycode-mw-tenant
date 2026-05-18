import { applyTenantEq } from '@/lib/masjidweb/apply-tenant-eq';

type CollectionItemTimestampUpdateQuery = {
  eq: (column: string, value: string) => CollectionItemTimestampUpdateQuery;
  in: (column: string, value: boolean[]) => CollectionItemTimestampUpdateQuery;
};

export function scopeCollectionItemTimestampUpdate<Q extends CollectionItemTimestampUpdateQuery>(
  query: Q,
  itemId: string,
  tenantId: string | null | undefined,
): Q {
  const scoped = query
    .eq('id', itemId)
    .in('is_published', [true, false]) as Q;

  return applyTenantEq(scoped, tenantId);
}
