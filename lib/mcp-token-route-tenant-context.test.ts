import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  validateToken: vi.fn(),
  runWithEffectiveTenantId: vi.fn(),
  handleRequest: vi.fn(),
  connect: vi.fn(),
}));

vi.mock('@/lib/repositories/mcpTokenRepository', () => ({
  validateToken: mocks.validateToken,
}));

vi.mock('@/lib/masjidweb/effective-tenant-id', () => ({
  runWithEffectiveTenantId: mocks.runWithEffectiveTenantId,
}));

vi.mock('@/lib/mcp/server', () => ({
  createMcpServer: () => ({
    connect: mocks.connect,
  }),
}));

vi.mock('@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js', () => ({
  WebStandardStreamableHTTPServerTransport: class {
    sessionId = 'session-1';
    onclose: (() => void) | undefined;

    constructor(options: { onsessioninitialized?: (sessionId: string) => void }) {
      setTimeout(() => options.onsessioninitialized?.('session-1'), 0);
    }

    handleRequest = mocks.handleRequest;
    close = vi.fn().mockResolvedValue(undefined);
  },
}));

import { GET, POST } from '@/app/(builder)/ycode/mcp/[token]/route';
import { POST as oauthPOST } from '@/app/(builder)/ycode/mcp/route';

vi.mock('@/lib/oauth/metadata', () => ({
  getBaseUrl: () => 'https://tenant.example.com',
}));

describe('MCP token route tenant context', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.validateToken.mockResolvedValue({
      id: 'token-1',
      name: 'Claude',
      token_prefix: 'ymc_123',
      tenant_id: 'tenant-1',
      is_active: true,
      last_used_at: null,
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-01T00:00:00.000Z',
    });
    mocks.runWithEffectiveTenantId.mockImplementation((_tenantId: string, fn: () => Promise<Response>) => fn());
    mocks.connect.mockResolvedValue(undefined);
    mocks.handleRequest.mockResolvedValue(new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));
  });

  it('executes POST MCP requests with the tenant_id from the validated token', async () => {
    const request = new Request('https://tenant.example.com/ycode/mcp/ymc_plain', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
    });

    await POST(request as never, { params: Promise.resolve({ token: 'ymc_plain' }) });

    expect(mocks.validateToken).toHaveBeenCalledWith('ymc_plain');
    expect(mocks.runWithEffectiveTenantId).toHaveBeenCalledWith('tenant-1', expect.any(Function));
  });

  it('OAuth Bearer route also runs MCP requests under the token tenant_id', async () => {
    const request = new Request('https://tenant.example.com/ycode/mcp', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        Authorization: 'Bearer access-token-123',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
    });

    await oauthPOST(request as never);

    expect(mocks.validateToken).toHaveBeenCalledWith('access-token-123');
    expect(mocks.runWithEffectiveTenantId).toHaveBeenCalledWith('tenant-1', expect.any(Function));
  });

  it('executes GET MCP requests with the tenant_id from the validated token', async () => {
    const initRequest = new Request('https://tenant.example.com/ycode/mcp/ymc_plain', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
    });
    await POST(initRequest as never, { params: Promise.resolve({ token: 'ymc_plain' }) });
    await new Promise((resolve) => setTimeout(resolve, 0));
    mocks.runWithEffectiveTenantId.mockClear();

    const request = new Request('https://tenant.example.com/ycode/mcp/ymc_plain', {
      method: 'GET',
      headers: { 'mcp-session-id': 'session-1' },
    });

    await GET(request as never, { params: Promise.resolve({ token: 'ymc_plain' }) });

    expect(mocks.runWithEffectiveTenantId).toHaveBeenCalledWith('tenant-1', expect.any(Function));
  });
});
