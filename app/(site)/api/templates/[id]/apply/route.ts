import { NextRequest } from 'next/server';
import { noCache } from '@/lib/api-response';
import { applyTemplate } from '@/lib/services/templateService';
import { clearAllCache, getAllPublishedRoutes, warmRoutes } from '@/lib/services/cacheService';

export const dynamic = 'force-dynamic';
export const revalidate = 0;
// MASJIDWEB_SEAM: netlify-cache-warming — on Netlify the post-purge cache
// warming below runs inline (see warmRouteChain), adding roughly one parallel
// page-render's wall time; give the function room beyond the default timeout.
export const maxDuration = 60;
// MASJIDWEB_SEAM_END

/**
 * POST /api/templates/:id/apply
 *
 * Apply a template to the current database.
 * This will clear existing content and replace it with template content.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  // Get tenant ID from header (for cloud multi-tenant)
  const tenantId = request.headers.get('x-tenant-id') || undefined;

  try {
    const result = await applyTemplate(id, tenantId);

    if (!result.success) {
      console.error(`[POST /api/templates/${id}/apply] Failed:`, result.error);
      return noCache({ error: result.error }, 500);
    }

    // Template application swapped out every page, component, style, color
    // variable, etc. — without invalidation the CDN would keep serving the
    // previous site's HTML indefinitely. Warm afterwards so the user's
    // first visit to the new site is a HIT, not a cold render.
    // Scope the purge to THIS tenant: an untenanted clearAllCache() does a
    // full-site purge + revalidatePath('/', 'layout'), which on Netlify
    // re-colds EVERY tenant's durable cache for a one-tenant action (the
    // same incident class fbcbd12 fixed for publishes). Falls back to the
    // legacy global clear only when no tenant header is present.
    try {
      await clearAllCache(tenantId ?? null);
      const routes = await getAllPublishedRoutes();
      const warmResult = await warmRoutes(routes, request);
      if (warmResult) {
        console.log(
          `[Cache] template apply: warming ${warmResult.warmed}${warmResult.total > warmResult.warmed ? ` of ${warmResult.total}` : ''} route(s) in background`,
        );
      }
    } catch (cacheError) {
      // Non-fatal: template applied successfully, only cache hygiene failed
      console.error(`[POST /api/templates/${id}/apply] Cache invalidation failed:`, cacheError);
    }

    return noCache({
      success: true,
      message: `Template "${result.templateName}" applied successfully`,
      templateName: result.templateName,
    });
  } catch (error) {
    console.error(`[POST /api/templates/${id}/apply] Error:`, error);

    return noCache(
      { error: error instanceof Error ? error.message : 'Failed to apply template' },
      500
    );
  }
}
