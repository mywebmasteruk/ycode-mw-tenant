import { NextRequest, NextResponse } from 'next/server';
import { getSettingByKey, setSetting } from '@/lib/repositories/settingsRepository';
import { resolveEffectiveTenantId } from '@/lib/masjidweb/effective-tenant-id';
import { clearAllCache, getAllPublishedRoutes, warmRoutes } from '@/lib/services/cacheService';

/**
 * Setting keys that don't affect public-page rendering and therefore should
 * NOT trigger a cache nuke when updated.
 */
const DRAFT_ONLY_SETTING_KEYS = new Set(['draft_css', 'email']);

/**
 * GET /ycode/api/settings/[key]
 *
 * Get a setting value by key
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ key: string }> }
) {
  try {
    const { key } = await params;
    const value = await getSettingByKey(key);

    if (value === null) {
      return NextResponse.json(
        { error: 'Setting not found' },
        { status: 404 }
      );
    }

    return NextResponse.json({ data: value });
  } catch (error) {
    console.error('[API] Error fetching setting:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to fetch setting' },
      { status: 500 }
    );
  }
}

/**
 * PUT /ycode/api/settings/[key]
 *
 * Update a setting value
 */
export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ key: string }> }
) {
  try {
    const { key } = await params;
    const body = await request.json();
    const { value } = body;

    if (value === undefined) {
      return NextResponse.json(
        { error: 'Missing value in request body' },
        { status: 400 }
      );
    }

    await setSetting(key, value);

    if (!DRAFT_ONLY_SETTING_KEYS.has(key)) {
      await clearAllCache(await resolveEffectiveTenantId());

      try {
        const routes = await getAllPublishedRoutes();
        const warmResult = await warmRoutes(routes, request);
        if (warmResult) {
          console.log(
            `[Cache] settings (${key}): warming ${warmResult.warmed}${warmResult.total > warmResult.warmed ? ` of ${warmResult.total}` : ''} route(s) in background`,
          );
        }
      } catch {
        // Non-fatal: warming is an optimization
      }
    }

    return NextResponse.json({
      data: { key, value },
      message: 'Setting updated successfully',
    });
  } catch (error) {
    console.error('[API] Error updating setting:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to update setting' },
      { status: 500 }
    );
  }
}
