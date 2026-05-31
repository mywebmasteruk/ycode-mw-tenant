import { NextRequest } from 'next/server';
import {
  authenticateToken,
  handleMcpPost,
  handleMcpGet,
  handleMcpDelete,
  addCorsHeaders,
  unauthorizedJson,
} from '@/lib/mcp/handler';
import { runWithEffectiveTenantId } from '@/lib/masjidweb/effective-tenant-id';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

/**
 * Legacy URL-token MCP endpoint.
 *
 * Used by Cursor, Windsurf, Claude Desktop, and Claude Code — clients that
 * accept an MCP URL with the auth token embedded in the path. Claude.ai web
 * and ChatGPT use the sibling `/ycode/mcp` route, which authenticates via
 * `Authorization: Bearer <token>` headers issued by the OAuth flow.
 */

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ token: string }> },
) {
  const { token } = await params;
  const mcpToken = await authenticateToken(token);
  if (!mcpToken) {
    return unauthorizedJson('Invalid MCP token');
  }
  
  // MASJIDWEB_SEAM: MCP tenant context — see docs/masjidweb-core-seams.md#tier-4
  return mcpToken.tenant_id
    ? await runWithEffectiveTenantId(mcpToken.tenant_id, () => handleMcpPost(request))
    : await handleMcpPost(request);
  // MASJIDWEB_SEAM_END
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ token: string }> },
) {
  const { token } = await params;
  const mcpToken = await authenticateToken(token);
  if (!mcpToken) {
    return unauthorizedJson('Invalid MCP token');
  }
  
  // MASJIDWEB_SEAM: MCP tenant context — see docs/masjidweb-core-seams.md#tier-4
  return mcpToken.tenant_id
    ? await runWithEffectiveTenantId(mcpToken.tenant_id, () => handleMcpGet(request))
    : await handleMcpGet(request);
  // MASJIDWEB_SEAM_END
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ token: string }> },
) {
  const { token } = await params;
  const mcpToken = await authenticateToken(token);
  if (!mcpToken) {
    return unauthorizedJson('Invalid MCP token');
  }
  
  // MASJIDWEB_SEAM: MCP tenant context — see docs/masjidweb-core-seams.md#tier-4
  return mcpToken.tenant_id
    ? await runWithEffectiveTenantId(mcpToken.tenant_id, () => handleMcpDelete(request))
    : await handleMcpDelete(request);
  // MASJIDWEB_SEAM_END
}

export async function OPTIONS() {
  return addCorsHeaders(new Response(null, { status: 204 }));
}
