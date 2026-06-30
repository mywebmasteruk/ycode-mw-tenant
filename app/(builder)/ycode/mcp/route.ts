import { NextRequest } from 'next/server';
import {
  authenticateToken,
  handleMcpPost,
  handleMcpGet,
  handleMcpDelete,
  addCorsHeaders,
  buildWwwAuthenticateHeader,
} from '@/lib/mcp/handler';
import { getBaseUrl } from '@/lib/oauth/metadata';
import { runWithEffectiveTenantId } from '@/lib/masjidweb/effective-tenant-id';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

/**
 * OAuth Bearer-token MCP endpoint.
 *
 * Used by clients that authenticate per the MCP authorization spec
 * (Claude.ai web, ChatGPT). Returns 401 with a `WWW-Authenticate` header
 * pointing to the protected-resource metadata so unauthenticated clients
 * can discover the OAuth flow.
 *
 * The shared session/transport logic lives in `lib/mcp/handler.ts` and is
 * also used by the legacy URL-token endpoint at `/ycode/mcp/[token]`.
 */

function extractBearerToken(request: NextRequest): string | null {
  const header = request.headers.get('authorization') || request.headers.get('Authorization');
  if (!header) return null;
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : null;
}

function unauthorizedWithChallenge(request: NextRequest, message: string): Response {
  const baseUrl = getBaseUrl(request);
  const response = new Response(JSON.stringify({ error: message }), {
    status: 401,
    headers: {
      'Content-Type': 'application/json',
      'WWW-Authenticate': buildWwwAuthenticateHeader(baseUrl),
    },
  });
  return addCorsHeaders(response);
}

/**
 * Authenticate the Bearer token. Returns the validated MCP token (which carries
 * its tenant_id) or a 401 challenge Response. The tenant_id MUST then scope the
 * handler — same contract the URL-token route enforces.
 */
async function authorize(
  request: NextRequest,
): Promise<{ mcpToken: NonNullable<Awaited<ReturnType<typeof authenticateToken>>> } | { denied: Response }> {
  const token = extractBearerToken(request);
  if (!token) {
    return { denied: unauthorizedWithChallenge(request, 'Authorization required') };
  }

  const mcpToken = await authenticateToken(token);
  if (!mcpToken) {
    return { denied: unauthorizedWithChallenge(request, 'Invalid or expired access token') };
  }

  return { mcpToken };
}

export async function POST(request: NextRequest) {
  const auth = await authorize(request);
  if ('denied' in auth) return auth.denied;
  // MASJIDWEB_SEAM: MCP tenant context — see docs/masjidweb-core-seams.md#tier-4
  // Bearer (OAuth) requests must run under the token's tenant, exactly like the
  // URL-token route; without this they fall back to the env-default tenant.
  return auth.mcpToken.tenant_id
    ? await runWithEffectiveTenantId(auth.mcpToken.tenant_id, () => handleMcpPost(request))
    : await handleMcpPost(request);
  // MASJIDWEB_SEAM_END
}

export async function GET(request: NextRequest) {
  const auth = await authorize(request);
  if ('denied' in auth) return auth.denied;
  // MASJIDWEB_SEAM: MCP tenant context — see docs/masjidweb-core-seams.md#tier-4
  return auth.mcpToken.tenant_id
    ? await runWithEffectiveTenantId(auth.mcpToken.tenant_id, () => handleMcpGet(request))
    : await handleMcpGet(request);
  // MASJIDWEB_SEAM_END
}

export async function DELETE(request: NextRequest) {
  const auth = await authorize(request);
  if ('denied' in auth) return auth.denied;
  // MASJIDWEB_SEAM: MCP tenant context — see docs/masjidweb-core-seams.md#tier-4
  return auth.mcpToken.tenant_id
    ? await runWithEffectiveTenantId(auth.mcpToken.tenant_id, () => handleMcpDelete(request))
    : await handleMcpDelete(request);
  // MASJIDWEB_SEAM_END
}

export async function OPTIONS() {
  return addCorsHeaders(new Response(null, { status: 204 }));
}
