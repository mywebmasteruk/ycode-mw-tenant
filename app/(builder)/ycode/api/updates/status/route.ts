import packageJson from '../../../../../../package.json';
import { noCache } from '@/lib/api-response';
import { getAdminUpdateCenterStatus } from '@/lib/masjidweb/update-center';
import { requireTemplateTenantForUpdates } from '@/lib/masjidweb/update-tenant-access';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function GET() {
  const forbidden = await requireTemplateTenantForUpdates();
  if (forbidden) return forbidden;

  const result = await getAdminUpdateCenterStatus(packageJson.version);
  return noCache(result, result.ok ? 200 : 500);
}
