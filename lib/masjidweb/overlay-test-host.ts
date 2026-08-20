/**
 * Experiment-only: resolve a tenant Host without DNS.
 * Dead on production because MW_OVERLAY_FAIL_CLOSED is unset there.
 */
export function overlayTestHostname(
  headers: Headers,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  if (env.MW_OVERLAY_FAIL_CLOSED !== 'true') return null;
  const expected = env.MW_OVERLAY_TEST_SECRET?.trim();
  if (!expected) return null;
  if (headers.get('x-mw-overlay-test-secret') !== expected) return null;
  const raw = headers.get('x-mw-overlay-test-host')?.trim().toLowerCase() ?? '';
  const host = raw.replace(/:\d+$/, '');
  if (!host || host.includes('/') || host.includes('\\') || /\s/.test(host)) {
    return null;
  }
  return host;
}
