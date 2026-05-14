import packageJson from '../../../../../../package.json';
import { noCache } from '@/lib/api-response';
import { requireTemplateTenantForUpdates } from '@/lib/masjidweb/update-tenant-access';
import { checkForUpdates } from '@/lib/updates/check-updates';

// Disable caching for this route
export const dynamic = 'force-dynamic';
export const revalidate = 0;

/**
 * GET /ycode/api/updates/check
 *
 * Check for updates from the official Ycode repository
 */
export async function GET() {
  const forbidden = await requireTemplateTenantForUpdates();
  if (forbidden) return forbidden;

  const result = await checkForUpdates(packageJson.version);
  return noCache(result);
}
