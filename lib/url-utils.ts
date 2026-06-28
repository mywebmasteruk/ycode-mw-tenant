/**
 * Resolve the site's base URL from settings and environment.
 *
 * Priority: globalCanonicalUrl > primaryDomainUrl > NEXT_PUBLIC_SITE_URL
 *         > VERCEL_PROJECT_PRODUCTION_URL > VERCEL_URL
 */
export function getSiteBaseUrl(options?: {
  globalCanonicalUrl?: string | null;
  primaryDomainUrl?: string | null;
}): string | null {
  const raw =
    options?.globalCanonicalUrl
    || options?.primaryDomainUrl
    || process.env.NEXT_PUBLIC_SITE_URL
    || (process.env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}` : null)
    || (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : null)
    || null;

  return raw ? raw.replace(/\/$/, '') : null;
}

/**
 * Join a base URL with a page path into an absolute URL.
 * Returns the base (without trailing slash) for the homepage path.
 */
export function buildAbsolutePageUrl(baseUrl: string, pagePath: string): string {
  const base = baseUrl.replace(/\/$/, '');
  if (pagePath === '/' || pagePath === '') {
    return base;
  }
  return `${base}${pagePath.startsWith('/') ? pagePath : '/' + pagePath}`;
}
