import { NextRequest } from 'next/server';
import { runResync } from '@/lib/apps/webflow/migration-service';
import { noCache } from '@/lib/api-response';

export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const maxDuration = 300;

/**
 * POST /ycode/api/apps/webflow/sync
 * Body: { importId: string }
 *
 * Re-sync items + publish state for an existing import. Schema diffs are
 * NOT applied to keep re-sync safe — use a fresh migration to capture them.
 */
export async function POST(request: NextRequest) {
  try {
    const { importId } = await request.json();

    if (!importId || typeof importId !== 'string') {
      return noCache({ error: 'importId is required' }, 400);
    }

    const result = await runResync(importId);
    return noCache({ data: result });
  } catch (error) {
    console.error('Error re-syncing Webflow import:', error);
    return noCache(
      { error: error instanceof Error ? error.message : 'Re-sync failed' },
      500
    );
  }
}
