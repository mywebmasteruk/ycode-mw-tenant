import { NextRequest } from 'next/server';
<<<<<<< HEAD
import { randomUUID } from 'crypto';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { validateToken, type McpToken } from '@/lib/repositories/mcpTokenRepository';
import { createMcpServer } from '@/lib/mcp/server';
import { runWithEffectiveTenantId } from '@/lib/masjidweb/effective-tenant-id';
=======
import {
  authenticateToken,
  handleMcpPost,
  handleMcpGet,
  handleMcpDelete,
  addCorsHeaders,
  unauthorizedJson,
} from '@/lib/mcp/handler';
>>>>>>> upstream/main

export const dynamic = 'force-dynamic';
export const revalidate = 0;

<<<<<<< HEAD
interface McpSession {
  transport: WebStandardStreamableHTTPServerTransport;
  server: McpServer;
  lastActivity: number;
}

const sessions = new Map<string, McpSession>();

const SESSION_TIMEOUT_MS = 30 * 60 * 1000;

function cleanupStaleSessions() {
  const now = Date.now();
  for (const [id, session] of sessions) {
    if (now - session.lastActivity > SESSION_TIMEOUT_MS) {
      session.transport.close().catch(() => {});
      sessions.delete(id);
    }
  }
}

async function authenticateToken(token: string): Promise<McpToken | null> {
  try {
    return await validateToken(token);
  } catch {
    return null;
  }
}

function addCorsHeaders(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set('Access-Control-Allow-Origin', '*');
  headers.set('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  headers.set('Access-Control-Allow-Headers', 'Content-Type, mcp-session-id, mcp-protocol-version');
  headers.set('Access-Control-Expose-Headers', 'mcp-session-id');

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function createSessionTransport() {
  const server = createMcpServer();
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
    enableJsonResponse: true,
    onsessioninitialized: (newSessionId) => {
      sessions.set(newSessionId, { transport, server, lastActivity: Date.now() });
    },
  });

  transport.onclose = () => {
    if (transport.sessionId) {
      sessions.delete(transport.sessionId);
    }
  };

  return { server, transport };
}

=======
>>>>>>> upstream/main
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
<<<<<<< HEAD

  try {
    const mcpToken = await authenticateToken(token);
    if (!mcpToken) {
      return new Response(JSON.stringify({ error: 'Invalid MCP token' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    cleanupStaleSessions();
    const response = mcpToken.tenant_id
      ? await runWithEffectiveTenantId(mcpToken.tenant_id, () => handleMcpRequest(request))
      : await handleMcpRequest(request);
    return addCorsHeaders(response);
  } catch (error) {
    console.error('[MCP POST] Error:', error);
    return addCorsHeaders(new Response(JSON.stringify({
      jsonrpc: '2.0',
      error: { code: -32603, message: error instanceof Error ? error.message : 'Internal server error' },
      id: null,
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    }));
=======
  if (!(await authenticateToken(token))) {
    return unauthorizedJson('Invalid MCP token');
>>>>>>> upstream/main
  }
  return handleMcpPost(request);
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ token: string }> },
) {
  const { token } = await params;
<<<<<<< HEAD

  try {
    const mcpToken = await authenticateToken(token);
    if (!mcpToken) {
      return new Response(JSON.stringify({ error: 'Invalid MCP token' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const sessionId = request.headers.get('mcp-session-id');
    if (!sessionId || !sessions.has(sessionId)) {
      return addCorsHeaders(new Response(JSON.stringify({
        jsonrpc: '2.0',
        error: { code: -32000, message: 'Session not found. Send a POST initialize first.' },
        id: null,
      }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      }));
    }

    const session = sessions.get(sessionId)!;
    session.lastActivity = Date.now();
    const response = mcpToken.tenant_id
      ? await runWithEffectiveTenantId(mcpToken.tenant_id, () => session.transport.handleRequest(request))
      : await session.transport.handleRequest(request);
    return addCorsHeaders(response);
  } catch (error) {
    console.error('[MCP GET] Error:', error);
    return addCorsHeaders(new Response(JSON.stringify({
      jsonrpc: '2.0',
      error: { code: -32603, message: error instanceof Error ? error.message : 'Internal server error' },
      id: null,
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    }));
=======
  if (!(await authenticateToken(token))) {
    return unauthorizedJson('Invalid MCP token');
>>>>>>> upstream/main
  }
  return handleMcpGet(request);
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ token: string }> },
) {
  const { token } = await params;
<<<<<<< HEAD

  try {
    const mcpToken = await authenticateToken(token);
    if (!mcpToken) {
      return new Response(JSON.stringify({ error: 'Invalid MCP token' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const sessionId = request.headers.get('mcp-session-id');
    if (sessionId && sessions.has(sessionId)) {
      const closeSession = async () => {
        const session = sessions.get(sessionId)!;
        await session.transport.close();
        sessions.delete(sessionId);
        return addCorsHeaders(new Response(null, { status: 204 }));
      };
      return mcpToken.tenant_id
        ? await runWithEffectiveTenantId(mcpToken.tenant_id, closeSession)
        : await closeSession();
    }

    return addCorsHeaders(new Response(null, { status: 204 }));
  } catch (error) {
    console.error('[MCP DELETE] Error:', error);
    return addCorsHeaders(new Response(null, { status: 204 }));
=======
  if (!(await authenticateToken(token))) {
    return unauthorizedJson('Invalid MCP token');
>>>>>>> upstream/main
  }
  return handleMcpDelete(request);
}

export async function OPTIONS() {
  return addCorsHeaders(new Response(null, { status: 204 }));
}
