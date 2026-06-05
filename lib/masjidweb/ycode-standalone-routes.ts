// MASJIDWEB_SEAM: standalone-route-exclusion — see docs/masjidweb-core-seams.md#tier-5
const prefixRoutes = ['/ycode/preview', '/ycode/devtools/', '/ycode/oauth/'];
const exactRoutes = ['/ycode/welcome', '/ycode/accept-invite'];

export function isStandaloneYcodeRoute(pathname: string): boolean {
  return prefixRoutes.some(route => pathname.startsWith(route))
    || exactRoutes.includes(pathname);
}

export const standaloneYcodeExactRoutes = exactRoutes;
// MASJIDWEB_SEAM_END
