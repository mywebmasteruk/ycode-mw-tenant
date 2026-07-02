/**
 * MASJIDWEB internal route — 404 boundary for the cacheable tenant routes.
 * Re-exports the (site) not-found page so canary-tenant 404s render the same
 * tenant-custom 404 as the header-based routes. not-found boundaries receive
 * no params, so this one still resolves its tenant internally (headers() is
 * still available at request time — the x-tenant-id header is on the request
 * either way); that only makes the 404 RESPONSE dynamic, which is fine — it
 * does not affect the cacheability of successful page renders.
 */
export { default } from '../../(site)/not-found';
