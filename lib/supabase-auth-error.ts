export function isStaleSupabaseRefreshTokenError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? '');
  const normalized = message.toLowerCase();

  return normalized.includes('invalid refresh token') || normalized.includes('refresh token not found');
}
