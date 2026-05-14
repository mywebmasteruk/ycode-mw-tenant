import { NextRequest } from 'next/server';
import { runMigration } from '@/lib/apps/webflow/migration-service';
import { noCache } from '@/lib/api-response';

export const dynamic = 'force-dynamic';
export const revalidate = 0;
/** Migrations involve N item-list calls + asset downloads — give them headroom. */
export const maxDuration = 300;

/**
 * POST /ycode/api/apps/webflow/migrate
 * Body: { siteId: string }
 *
 * Runs a one-click full migration for a Webflow site: creates YCode
 * collections + fields, imports items as drafts, resolves references, and
 * publishes items currently live on Webflow.
 */
export async function POST(request: NextRequest) {
  try {
    const { siteId } = await request.json();

    if (!siteId || typeof siteId !== 'string') {
      return noCache({ error: 'siteId is required' }, 400);
    }

    const { import: importRecord, result } = await runMigration(siteId);
    return noCache({ data: { import: importRecord, result } }, 201);
  } catch (error) {
    console.error('Error running Webflow migration:', error);
    return noCache(
      { error: error instanceof Error ? error.message : 'Migration failed' },
      500
    );
  }
}
