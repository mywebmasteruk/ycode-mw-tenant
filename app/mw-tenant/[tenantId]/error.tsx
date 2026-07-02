'use client';

/**
 * MASJIDWEB internal route — error boundary for the cacheable tenant routes.
 * Re-exports the (site) error page so canary-tenant errors render identically
 * to the header-based routes (client component, no Dynamic API involvement).
 */
export { default } from '../../(site)/error';
