import { UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js';
import type { McpServerSpawnConfig, McpWorkerEvent } from '@shared/types/agent';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const clientState = {
  instances: 0,
  closed: 0,
  connect: vi.fn(async () => {}),
  listTools: vi.fn(async () => ({ tools: [] as { name: string; inputSchema: unknown }[] })),
  callTool: vi.fn(async () => ({ content: [{ type: 'text', text: 'ok' }] })),
};

const transportState = {
  http: [] as { url: URL; options?: { authProvider?: unknown } }[],
  stdio: [] as Record<string, unknown>[],
};

vi.mock('@modelcontextprotocol/sdk/client/index.js', () => ({
  Client: class {
    constructor() {
      clientState.instances += 1;
    }
    connect(...args: unknown[]) {
      return clientState.connect(...(args as []));
    }
    listTools() {
      return clientState.listTools();
    }
    callTool(...args: unknown[]) {
      return clientState.callTool(...(args as []));
    }
    close() {
      clientState.closed += 1;
      return Promise.resolve();
    }
  },
}));

vi.mock('@modelcontextprotocol/sdk/client/streamableHttp.js', () => ({
  StreamableHTTPClientTransport: class {
    constructor(url: URL, options?: { authProvider?: unknown }) {
      transportState.http.push({ url, options });
    }
  },
}));

vi.mock('@modelcontextprotocol/sdk/client/sse.js', () => ({
  SSEClientTransport: class {
    constructor(url: URL, options?: { authProvider?: unknown }) {
      transportState.http.push({ url, options });
    }
  },
}));

vi.mock('@modelcontextprotocol/sdk/client/stdio.js', () => ({
  StdioClientTransport: class {
    constructor(options: Record<string, unknown>) {
      transportState.stdio.push(options);
    }
  },
}));

const { isRetriableMcpConnectionError, McpManager, oauthFingerprint } = await import('./mcp');

const httpServer: McpServerSpawnConfig = {
  id: 'srv-1',
  name: 'notion',
  transport: 'http',
  url: 'https://mcp.notion.com/mcp',
};

const makeManager = () => {
  const events: McpWorkerEvent[] = [];
  const manager = new McpManager({ emit: (event) => events.push(event) });
  return { manager, events };
};

const authProviderOf = (index = 0) =>
  transportState.http[index]?.options?.authProvider as {
    tokens(): unknown;
    saveTokens(tokens: unknown): void | Promise<void>;
    redirectToAuthorization(url: URL): void | Promise<void>;
    redirectUrl: unknown;
  };

beforeEach(() => {
  clientState.instances = 0;
  clientState.closed = 0;
  clientState.connect = vi.fn(async () => {});
  clientState.listTools = vi.fn(async () => ({ tools: [] }));
  clientState.callTool = vi.fn(async () => ({ content: [{ type: 'text', text: 'ok' }] }));
  transportState.http = [];
  transportState.stdio = [];
});

describe('McpManager status reporting', () => {
  it('reports connecting then ready with tool count', async () => {
    clientState.listTools = vi.fn(async () => ({
      tools: [
        { name: 'search', inputSchema: { type: 'object' } },
        { name: 'fetch', inputSchema: { type: 'object' } },
      ],
    }));
    const { manager, events } = makeManager();
    const tools = await manager.toolsFor([httpServer]);
    expect(tools).toHaveLength(2);
    expect(events).toEqual([
      { type: 'mcp-status', serverId: 'srv-1', serverName: 'notion', state: 'connecting' },
      {
        type: 'mcp-status',
        serverId: 'srv-1',
        serverName: 'notion',
        state: 'ready',
        toolCount: 2,
      },
    ]);
  });

  it('reports error with reason when connect fails', async () => {
    clientState.connect = vi.fn(async () => {
      throw new Error('boom');
    });
    const { manager, events } = makeManager();
    await manager.toolsFor([httpServer]);
    const last = events.at(-1);
    expect(last).toMatchObject({ type: 'mcp-status', state: 'error' });
    expect((last as { error?: string }).error).toContain('boom');
  });

  it('reports unauthorized on UnauthorizedError', async () => {
    clientState.connect = vi.fn(async () => {
      throw new UnauthorizedError('401');
    });
    const { manager, events } = makeManager();
    await manager.toolsFor([httpServer]);
    expect(events.at(-1)).toMatchObject({ state: 'unauthorized', serverId: 'srv-1' });
  });

  it('reports unauthorized when the provider asks for interactive authorization', async () => {
    clientState.connect = vi.fn(async () => {
      await authProviderOf().redirectToAuthorization(new URL('https://example.com/auth'));
    });
    const { manager, events } = makeManager();
    await manager.toolsFor([httpServer]);
    expect(events.at(-1)).toMatchObject({ state: 'unauthorized' });
  });
});

describe('McpManager oauth provider', () => {
  it('exposes configured tokens and emits refreshed tokens on save', async () => {
    const { manager, events } = makeManager();
    await manager.toolsFor([
      { ...httpServer, oauth: { access_token: 'old', refresh_token: 'r1' } },
    ]);
    const provider = authProviderOf();
    expect(provider.tokens()).toMatchObject({ access_token: 'old', token_type: 'Bearer' });
    expect(provider.redirectUrl).toBeUndefined();

    await provider.saveTokens({ access_token: 'new', token_type: 'Bearer', refresh_token: 'r2' });
    expect(events.at(-1)).toEqual({
      type: 'mcp-tokens-refreshed',
      serverId: 'srv-1',
      tokens: { access_token: 'new', token_type: 'Bearer', refresh_token: 'r2' },
    });
    expect(provider.tokens()).toMatchObject({ access_token: 'new' });
  });

  it('回传前先裁剪：id_token 等非白名单字段不出 worker', async () => {
    const { manager, events } = makeManager();
    await manager.toolsFor([httpServer]);
    await authProviderOf().saveTokens({
      access_token: 'new',
      token_type: 'Bearer',
      refresh_token: 'r2',
      id_token: 'jwt',
    });
    expect(events.at(-1)).toEqual({
      type: 'mcp-tokens-refreshed',
      serverId: 'srv-1',
      tokens: { access_token: 'new', token_type: 'Bearer', refresh_token: 'r2' },
    });
  });

  it('does not emit refreshed tokens without a server id', async () => {
    const { manager, events } = makeManager();
    await manager.toolsFor([{ name: 'anon', transport: 'http', url: 'https://x.test/mcp' }]);
    await authProviderOf().saveTokens({ access_token: 'a', token_type: 'Bearer' });
    expect(events.some((event) => event.type === 'mcp-tokens-refreshed')).toBe(false);
  });
});

describe('oauthFingerprint', () => {
  it('不泄漏 token 明文且随 token 变化', () => {
    const a = oauthFingerprint({ access_token: 'super-secret' });
    const b = oauthFingerprint({ access_token: 'other' });
    expect(a).not.toContain('super-secret');
    expect(a).not.toBe(b);
    expect(oauthFingerprint({ access_token: 'super-secret' })).toBe(a);
    expect(oauthFingerprint(undefined)).toBe('');
  });
});

describe('McpManager connection cache', () => {
  it('token 不变时复用连接', async () => {
    const { manager } = makeManager();
    await manager.toolsFor([{ ...httpServer, oauth: { access_token: 'a' } }]);
    await manager.toolsFor([{ ...httpServer, oauth: { access_token: 'a' } }]);
    expect(clientState.instances).toBe(1);
  });

  it('token 变化时原地更新 provider，不重建也不关正在用的连接', async () => {
    const { manager } = makeManager();
    await manager.toolsFor([{ ...httpServer, oauth: { access_token: 'a' } }]);
    await manager.toolsFor([{ ...httpServer, oauth: { access_token: 'b' } }]);
    // 已跑会话的工具闭包捕获着这个 client，关了它等于弄坏它们
    expect(clientState.instances).toBe(1);
    expect(clientState.closed).toBe(0);
    expect((authProviderOf(0).tokens() as { access_token: string }).access_token).toBe('b');
  });

  it('worker 自己 refresh 后主进程回传同一 token，不回退也不重建', async () => {
    const { manager } = makeManager();
    await manager.toolsFor([{ ...httpServer, oauth: { access_token: 'a' } }]);
    await authProviderOf(0).saveTokens({ access_token: 'refreshed', token_type: 'Bearer' });
    await manager.toolsFor([{ ...httpServer, oauth: { access_token: 'a' } }]);
    expect(clientState.instances).toBe(1);
    expect((authProviderOf(0).tokens() as { access_token: string }).access_token).toBe('refreshed');
  });

  it('主进程不再下发凭据（撤销）时下线旧连接并重建', async () => {
    const { manager } = makeManager();
    await manager.toolsFor([{ ...httpServer, oauth: { access_token: 'a' } }]);
    await manager.toolsFor([httpServer]);
    expect(clientState.instances).toBe(2);
    await vi.waitFor(() => expect(clientState.closed).toBe(1));
    expect(authProviderOf(1).tokens()).toBeUndefined();
  });

  it('listTools 失败时关闭 client，不泄漏子进程', async () => {
    clientState.listTools = vi.fn(async () => {
      throw new Error('listTools boom');
    });
    const { manager } = makeManager();
    await manager.toolsFor([httpServer]);
    expect(clientState.closed).toBe(1);
  });

  it('retries after a failed connection so a new token can take effect', async () => {
    clientState.connect = vi.fn(async () => {
      throw new UnauthorizedError('401');
    });
    const { manager } = makeManager();
    await manager.toolsFor([httpServer]);
    clientState.connect = vi.fn(async () => {});
    await manager.toolsFor([{ ...httpServer, oauth: { access_token: 'fresh' } }]);
    expect(clientState.instances).toBe(2);
    expect((authProviderOf(1).tokens() as { access_token: string } | undefined)?.access_token).toBe(
      'fresh'
    );
  });
});

describe('McpManager per-server timeouts', () => {
  it('uses configured connectTimeoutMs for connect', async () => {
    vi.useFakeTimers();
    clientState.connect = vi.fn(() => new Promise(() => {}));
    const { manager, events } = makeManager();
    const pending = manager.toolsFor([{ ...httpServer, connectTimeoutMs: 50 }]);
    await vi.advanceTimersByTimeAsync(49);
    expect(events.some((event) => event.type === 'mcp-status' && event.state === 'error')).toBe(
      false
    );
    await vi.advanceTimersByTimeAsync(2);
    await pending;
    const last = events.at(-1);
    expect(last).toMatchObject({ type: 'mcp-status', state: 'error' });
    expect((last as { error?: string }).error).toContain('50ms');
    vi.useRealTimers();
  });

  it('uses configured callTimeoutMs for callTool', async () => {
    vi.useFakeTimers();
    clientState.listTools = vi.fn(async () => ({
      tools: [{ name: 'search', inputSchema: { type: 'object' } }],
    }));
    clientState.callTool = vi.fn(() => new Promise(() => {}));
    const { manager } = makeManager();
    const tools = await manager.toolsFor([{ ...httpServer, callTimeoutMs: 80 }]);
    const pending = tools[0]?.execute('tc-1', {}, undefined, undefined, {} as never);
    await vi.advanceTimersByTimeAsync(79);
    let settled = false;
    void pending?.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      }
    );
    await Promise.resolve();
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(2);
    await expect(pending).rejects.toThrow(/80ms/);
    vi.useRealTimers();
  });
});

describe('McpManager stdio', () => {
  it('keeps stdio transport untouched by oauth wiring', async () => {
    const { manager, events } = makeManager();
    await manager.toolsFor([
      { id: 's', name: 'local', transport: 'stdio', command: 'node', args: ['x.js'] },
    ]);
    expect(transportState.stdio).toHaveLength(1);
    expect(transportState.stdio[0]).toMatchObject({ command: 'node', args: ['x.js'] });
    expect(transportState.stdio[0]).not.toHaveProperty('authProvider');
    expect(events.at(-1)).toMatchObject({ state: 'ready', toolCount: 0 });
  });
});

describe('isRetriableMcpConnectionError', () => {
  it('treats stale transport and common network drops as retriable', () => {
    expect(isRetriableMcpConnectionError(new Error('Not connected'))).toBe(true);
    expect(isRetriableMcpConnectionError(new Error('transport closed'))).toBe(true);
    expect(isRetriableMcpConnectionError(new Error('HTTP 404: session gone'))).toBe(true);
    expect(isRetriableMcpConnectionError(new Error('ECONNRESET'))).toBe(true);
  });

  it('does not treat business or auth failures as retriable', () => {
    expect(isRetriableMcpConnectionError(new Error('tool exploded'))).toBe(false);
    expect(isRetriableMcpConnectionError(new Error('401 unauthorized'))).toBe(false);
    expect(isRetriableMcpConnectionError('Not connected')).toBe(false);
  });
});

describe('McpManager call retry', () => {
  it('reconnects once after Not connected and retries the same tool', async () => {
    clientState.listTools = vi.fn(async () => ({
      tools: [{ name: 'search', inputSchema: { type: 'object' } }],
    }));
    clientState.callTool = vi
      .fn()
      .mockRejectedValueOnce(new Error('Not connected'))
      .mockResolvedValueOnce({ content: [{ type: 'text', text: 'recovered' }] });
    const { manager } = makeManager();
    const tools = await manager.toolsFor([httpServer]);
    expect(clientState.instances).toBe(1);
    const result = await tools[0]?.execute('tc-1', { q: 'x' }, undefined, undefined, {} as never);
    expect(result?.content).toEqual([{ type: 'text', text: 'recovered' }]);
    expect(clientState.instances).toBe(2);
    expect(clientState.closed).toBe(1);
    expect(clientState.callTool).toHaveBeenCalledTimes(2);
  });

  it('does not reconnect on a business tool error', async () => {
    clientState.listTools = vi.fn(async () => ({
      tools: [{ name: 'search', inputSchema: { type: 'object' } }],
    }));
    clientState.callTool = vi.fn(async () => {
      throw new Error('query failed');
    });
    const { manager } = makeManager();
    const tools = await manager.toolsFor([httpServer]);
    await expect(tools[0]?.execute('tc-1', {}, undefined, undefined, {} as never)).rejects.toThrow(
      /query failed/
    );
    expect(clientState.instances).toBe(1);
    expect(clientState.callTool).toHaveBeenCalledTimes(1);
  });

  it('retries a stale call only once', async () => {
    clientState.listTools = vi.fn(async () => ({
      tools: [{ name: 'search', inputSchema: { type: 'object' } }],
    }));
    clientState.callTool = vi.fn(async () => {
      throw new Error('transport closed');
    });
    const { manager } = makeManager();
    const tools = await manager.toolsFor([httpServer]);
    await expect(tools[0]?.execute('tc-1', {}, undefined, undefined, {} as never)).rejects.toThrow(
      /transport closed/
    );
    expect(clientState.instances).toBe(2);
    expect(clientState.callTool).toHaveBeenCalledTimes(2);
  });
});
