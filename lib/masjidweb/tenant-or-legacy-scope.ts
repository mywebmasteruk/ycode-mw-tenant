type TenantOrLegacyQuery = {
  or: (filters: string) => unknown;
};

export function applyTenantOrLegacyScope<Q>(
  query: Q,
  tenantId: string | null | undefined,
  column = 'tenant_id',
): Q {
  if (!tenantId) return query;
  return (query as TenantOrLegacyQuery).or(`${column}.eq.${tenantId},${column}.is.null`) as Q;
}

export function isMissingTenantScopeColumnError(
  error: unknown,
  column = 'tenant_id',
): boolean {
  if (!error || typeof error !== 'object') return false;
  const maybeError = error as { code?: unknown; message?: unknown };
  const code = typeof maybeError.code === 'string' ? maybeError.code : '';
  const message = typeof maybeError.message === 'string' ? maybeError.message : '';

  return (
    code === '42703' ||
    code === 'PGRST204' ||
    (message.includes(column) && (
      message.includes('does not exist') ||
      message.includes('schema cache')
    ))
  );
}
