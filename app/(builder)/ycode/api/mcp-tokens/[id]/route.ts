import { NextRequest } from 'next/server';
import { getTokenById, deleteToken } from '@/lib/repositories/mcpTokenRepository';
import { noCache } from '@/lib/api-response';
import { resolveEffectiveTenantId } from '@/lib/masjidweb/effective-tenant-id';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

/**
 * GET /ycode/api/mcp-tokens/[id]
 * Get a single MCP token by ID
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const tenantId = await resolveEffectiveTenantId();
    const token = await getTokenById(id, tenantId);

    if (!token) {
      return noCache({ error: 'MCP token not found' }, 404);
    }

    return noCache({ data: token });
  } catch (error) {
    console.error('Error fetching MCP token:', error);
    return noCache(
      { error: error instanceof Error ? error.message : 'Failed to fetch MCP token' },
      500,
    );
  }
}

/**
 * DELETE /ycode/api/mcp-tokens/[id]
 * Delete an MCP token
 */
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const tenantId = await resolveEffectiveTenantId();

    const existing = await getTokenById(id, tenantId);
    if (!existing) {
      return noCache({ error: 'MCP token not found' }, 404);
    }

    await deleteToken(id, tenantId);

    return noCache({ data: { deleted: true, id } });
  } catch (error) {
    console.error('Error deleting MCP token:', error);
    return noCache(
      { error: error instanceof Error ? error.message : 'Failed to delete MCP token' },
      500,
    );
  }
}
