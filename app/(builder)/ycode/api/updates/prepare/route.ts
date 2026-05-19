import { noCache } from '@/lib/api-response';
import { prepareSafeUpdate } from '@/lib/masjidweb/update-center';
import { requireTemplateTenantForUpdates } from '@/lib/masjidweb/update-tenant-access';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function POST() {
  const forbidden = await requireTemplateTenantForUpdates();
  if (forbidden) return forbidden;

  try {
    const result = await prepareSafeUpdate();
    return noCache(result);
  } catch (error) {
    return noCache(
      {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
        message: 'Unable to start safe update preparation. Production has not changed.',
      },
      500
    );
  }
}
