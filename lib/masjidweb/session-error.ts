const INVALID_SESSION_ERRORS = new Set([
  'Not authenticated',
  'Tenant mismatch between session and site',
]);

export function isSessionInvalidError(error: unknown): boolean {
  return typeof error === 'string' && INVALID_SESSION_ERRORS.has(error);
}
