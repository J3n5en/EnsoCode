import { UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js';
import type {
  McpOAuthRefreshResult,
  McpServerSpawnConfig,
  McpWorkerEvent,
} from '@shared/types/agent';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const clientState = {
  instances: 0,
  closed: 0,
  connect: vi.fn(async () => {}),
  listTools: vi.fn(async () => ({ tools: [] as { name: string; inputSchema: unknown }[] })),
  callTool: vi.fn(async () => ({ content: [{ type: 'text', text: 'ok' }] })),
  instructions: undefined as string | undefined,
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
    listTools(...args: unknown[]) {
      return clientState.listTools(...(args as []));
    }
    callTool(...args: unknown[]) {
      return clientState.callTool(...(args as []));
    }
    getInstructions() {
      return clientState.instructions;
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

const makeManager = (
  refreshOAuth?: (serverId: string, rejected?: string) => Promise<McpOAuthRefreshResult>
) => {
  const events: McpWorkerEvent[] = [];
  const manager = new McpManager({
    emit: (event) => events.push(event),
    ...(refreshOAuth ? { refreshOAuth } : {}),
  });
  return { manager, events };
};

const originalFetch = globalThis.fetch;

/** 上游 MCP server：按序返回状态码，记下每次请求带的 Authorization */
function stubUpstream(...statuses: number[]) {
  const seen: (string | null)[] = [];
  globalThis.fetch = vi.fn(async (_input: unknown, init?: RequestInit) => {
    seen.push(new Headers(init?.headers).get('authorization'));
    return new Response('', { status: statuses.shift() ?? 200 });
  }) as never;
  return seen;
}

/** 经 transport 拿到的 fetch 发一次请求（SDK 实际发请求的入口） */
const send = (
  index = 0,
  init: RequestInit = {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  }
) => {
  const fetchFn = (transportState.http[index]?.options as { fetch?: typeof fetch } | undefined)
    ?.fetch;
  if (!fetchFn) throw new Error('transport has no fetch');
  return fetchFn('https://mcp.notion.com/mcp', init);
};

const refreshed = (access_token: string) =>
  vi.fn(async () => ({ ok: true as const, access: { access_token } }));

afterEach(() => {
  globalThis.fetch = originalFetch;
});

beforeEach(() => {
  clientState.instances = 0;
  clientState.closed = 0;
  clientState.connect = vi.fn(async () => {});
  clientState.listTools = vi.fn(async () => ({ tools: [] }));
  clientState.callTool = vi.fn(async () => ({ content: [{ type: 'text', text: 'ok' }] }));
  clientState.instructions = undefined;
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

  it('传输层 401（StreamableHTTPError.code）归为需授权', async () => {
    clientState.connect = vi.fn(async () => {
      throw Object.assign(new Error('Streamable HTTP error: Error POSTing to endpoint: '), {
        code: 401,
      });
    });
    const { manager, events } = makeManager();
    await manager.toolsFor([httpServer]);
    expect(events.at(-1)).toMatchObject({ state: 'unauthorized' });
  });
});

describe('McpManager server instructions', () => {
  const twoTools = () =>
    vi.fn(async () => ({
      tools: [
        { name: 'search', inputSchema: { type: 'object' } },
        { name: 'find_related', inputSchema: { type: 'object' } },
      ],
    }));

  it('把 server instructions 作为每个工具的同一条 prompt guideline（pi 按文本去重）', async () => {
    clientState.listTools = twoTools();
    clientState.instructions = 'Call `search` once.\nDo not grep for the same content.';
    const tools = await makeManager().manager.toolsFor([httpServer]);
    const [first, second] = tools.map((tool) => tool.promptGuidelines);
    expect(first).toEqual([
      'mcp__notion server instructions: Call `search` once. Do not grep for the same content.',
    ]);
    expect(second).toEqual(first);
  });

  it('无 instructions 或全空白时不加 guideline', async () => {
    clientState.listTools = twoTools();
    clientState.instructions = ' \n ';
    const tools = await makeManager().manager.toolsFor([httpServer]);
    expect(tools.every((tool) => tool.promptGuidelines === undefined)).toBe(true);
  });

  it('剥离控制字符并截断超长 instructions', async () => {
    clientState.listTools = twoTools();
    clientState.instructions = `a\u0000b\u202e${'x'.repeat(5000)}`;
    const [tool] = await makeManager().manager.toolsFor([httpServer]);
    const guideline = tool?.promptGuidelines?.[0] ?? '';
    expect(guideline).not.toContain('\u0000');
    expect(guideline).not.toContain('\u202e');
    expect(guideline.length).toBeLessThanOrEqual(2100);
    expect(guideline.endsWith('…')).toBe(true);
  });
});

describe('McpManager OAuth access', () => {
  it('transport 不持有 OAuth provider，请求带 Main 下发的 access token', async () => {
    const { manager } = makeManager();
    await manager.toolsFor([{ ...httpServer, oauth: { access_token: 'a' } }]);
    expect(transportState.http[0]?.options).not.toHaveProperty('authProvider');
    const seen = stubUpstream(200);
    await send();
    expect(seen).toEqual(['Bearer a']);
  });

  it('401 后带被拒 token 指纹请求 Main 刷新，用新 token 重试一次', async () => {
    const refreshOAuth = refreshed('b');
    const { manager } = makeManager(refreshOAuth);
    await manager.toolsFor([{ ...httpServer, oauth: { access_token: 'a' } }]);
    const seen = stubUpstream(401, 200, 200);
    expect((await send()).status).toBe(200);
    expect(refreshOAuth).toHaveBeenCalledWith('srv-1', oauthFingerprint({ access_token: 'a' }));
    expect(seen).toEqual(['Bearer a', 'Bearer b']);
    await send();
    expect(seen.at(-1)).toBe('Bearer b');
  });

  it('Main 判定需重新授权时原样交回 401，不重试', async () => {
    const refreshOAuth = vi.fn(async () => ({
      ok: false as const,
      unauthorized: true,
      error: 'invalid_grant',
    }));
    const { manager } = makeManager(refreshOAuth);
    await manager.toolsFor([{ ...httpServer, oauth: { access_token: 'a' } }]);
    const seen = stubUpstream(401);
    expect((await send()).status).toBe(401);
    expect(seen).toHaveLength(1);
  });

  it('并发 401 只向 Main 请求一次刷新', async () => {
    const refreshOAuth = refreshed('b');
    const { manager } = makeManager(refreshOAuth);
    await manager.toolsFor([{ ...httpServer, oauth: { access_token: 'a' } }]);
    stubUpstream(401, 401, 200, 200);
    const responses = await Promise.all([send(), send()]);
    expect(responses.map((response) => response.status)).toEqual([200, 200]);
    expect(refreshOAuth).toHaveBeenCalledTimes(1);
  });

  it('临期 token 先向 Main 续期再发请求', async () => {
    const refreshOAuth = refreshed('b');
    const { manager } = makeManager(refreshOAuth);
    await manager.toolsFor([
      { ...httpServer, oauth: { access_token: 'a', expires_at: Date.now() + 10_000 } },
    ]);
    const seen = stubUpstream(200);
    await send();
    expect(refreshOAuth).toHaveBeenCalledWith('srv-1', oauthFingerprint({ access_token: 'a' }));
    expect(seen).toEqual(['Bearer b']);
  });

  it('主动续期失败不阻断请求，同一 token 不反复续期', async () => {
    const refreshOAuth = vi.fn(async () => ({
      ok: false as const,
      unauthorized: false,
      error: 'down',
    }));
    const { manager } = makeManager(refreshOAuth);
    await manager.toolsFor([
      { ...httpServer, oauth: { access_token: 'a', expires_at: Date.now() + 10_000 } },
    ]);
    const seen = stubUpstream(200, 200);
    await send();
    await send();
    expect(seen).toEqual(['Bearer a', 'Bearer a']);
    expect(refreshOAuth).toHaveBeenCalledTimes(1);
  });

  it('刷新后旧会话配置回传被淘汰的 token，不回退也不重建', async () => {
    const { manager } = makeManager(refreshed('b'));
    await manager.toolsFor([{ ...httpServer, oauth: { access_token: 'a' } }]);
    const seen = stubUpstream(401, 200, 200, 200);
    await send();
    await manager.toolsFor([{ ...httpServer, oauth: { access_token: 'a' } }]);
    await send();
    await manager.resolve({ ...httpServer, oauth: { access_token: 'a' } });
    await send();
    expect(seen.slice(-2)).toEqual(['Bearer b', 'Bearer b']);
    expect(clientState.instances).toBe(1);
  });

  it('用户自配的 Authorization 头优先，不注入也不刷新', async () => {
    const refreshOAuth = refreshed('b');
    const { manager } = makeManager(refreshOAuth);
    await manager.toolsFor([{ ...httpServer, oauth: { access_token: 'a' } }]);
    const seen = stubUpstream(401);
    await send(0, { headers: { Authorization: 'Bearer custom' } });
    expect(seen).toEqual(['Bearer custom']);
    expect(refreshOAuth).not.toHaveBeenCalled();
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

  it('Main 下发新 token（重新授权）时原地更新，不重建也不关正在用的连接', async () => {
    const { manager } = makeManager();
    await manager.toolsFor([{ ...httpServer, oauth: { access_token: 'a' } }]);
    await manager.toolsFor([{ ...httpServer, oauth: { access_token: 'b' } }]);
    // 已跑会话的工具闭包捕获着这个 client，关了它等于弄坏它们
    expect(clientState.instances).toBe(1);
    expect(clientState.closed).toBe(0);
    const seen = stubUpstream(200);
    await send();
    expect(seen).toEqual(['Bearer b']);
  });

  it('主进程不再下发凭据（撤销）时下线旧连接并重建', async () => {
    const { manager } = makeManager();
    await manager.toolsFor([{ ...httpServer, oauth: { access_token: 'a' } }]);
    await manager.toolsFor([httpServer]);
    expect(clientState.instances).toBe(2);
    await vi.waitFor(() => expect(clientState.closed).toBe(1));
    const seen = stubUpstream(200);
    await send(1);
    expect(seen).toEqual([null]);
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
    const seen = stubUpstream(200);
    await send(1);
    expect(seen).toEqual(['Bearer fresh']);
  });

  it('失败后短时不重连，TTL 过后再试', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    clientState.connect = vi.fn(async () => {
      throw new Error('boom');
    });
    const { manager } = makeManager();
    await manager.toolsFor([httpServer]);
    expect(clientState.instances).toBe(1);
    await manager.toolsFor([httpServer]);
    expect(clientState.instances).toBe(1);
    vi.setSystemTime(15_001);
    await manager.toolsFor([httpServer]);
    expect(clientState.instances).toBe(2);
    vi.useRealTimers();
  });
});

describe('McpManager deferred servers', () => {
  it('resolve 成功返回该 server 的工具', async () => {
    clientState.listTools = vi.fn(async () => ({
      tools: [{ name: 'search', inputSchema: { type: 'object' } }],
    }));
    const { manager } = makeManager();
    const result = await manager.resolve(httpServer);
    expect(result.ok && result.tools.map((tool) => tool.name)).toEqual(['mcp__notion__search']);
  });

  it('工具名归一化后撞名时各自带哈希，调用仍落到原工具', async () => {
    clientState.listTools = vi.fn(async () => ({
      tools: [
        { name: 'read-file', inputSchema: { type: 'object' } },
        { name: 'read_file', inputSchema: { type: 'object' } },
      ],
    }));
    const { manager } = makeManager();
    const result = await manager.resolve({ ...httpServer, name: 'my-docs' });
    const names = result.ok ? result.tools.map((tool) => tool.name) : [];
    expect(names).toHaveLength(2);
    expect(new Set(names).size).toBe(2);
    for (const name of names) expect(name).toMatch(/^mcp__my_docs__read_file_[0-9a-f]{8}$/);
    expect(result.ok && result.tools[0].namespace?.name).toBe('mcp__my_docs');
  });

  it('namespace 描述优先用配置的 description，缺省回退服务器名', async () => {
    clientState.listTools = vi.fn(async () => ({
      tools: [{ name: 'search', inputSchema: { type: 'object' } }],
    }));
    const { manager } = makeManager();
    const described = await manager.resolve({ ...httpServer, description: 'Team wiki' });
    expect(described.ok && described.tools[0].namespace?.description).toBe('Team wiki');
    const plain = await manager.resolve({ ...httpServer, id: 'srv-2' });
    expect(plain.ok && plain.tools[0].namespace?.description).toBe('notion');
  });

  it('resolve 失败带原因与是否需授权，TTL 内复用同一原因', async () => {
    clientState.connect = vi.fn(async () => {
      throw new UnauthorizedError('401');
    });
    const { manager } = makeManager();
    const first = await manager.resolve(httpServer);
    expect(first).toMatchObject({ ok: false, unauthorized: true });
    expect(first.ok ? '' : first.error).toContain('401');
    expect(await manager.resolve(httpServer)).toEqual(first);
    expect(clientState.instances).toBe(1);
  });

  it('resolve 用最近下发的凭据，旧配置不会撤销别处刚授权的连接', async () => {
    const { manager } = makeManager();
    await manager.toolsFor([{ ...httpServer, oauth: { access_token: 'fresh' } }]);
    const result = await manager.resolve(httpServer);
    expect(result.ok).toBe(true);
    expect(clientState.instances).toBe(1);
    expect(clientState.closed).toBe(0);
  });

  it('refresh 不为未连接的 server 建连接，但记下凭据供之后 resolve 使用', async () => {
    const { manager } = makeManager();
    manager.refresh({ ...httpServer, oauth: { access_token: 'b' } });
    expect(clientState.instances).toBe(0);
    await manager.resolve(httpServer);
    const seen = stubUpstream(200);
    await send();
    expect(seen).toEqual(['Bearer b']);
  });

  it('refresh 把撤销同步给已建立的连接', async () => {
    const { manager } = makeManager();
    await manager.resolve({ ...httpServer, oauth: { access_token: 'a' } });
    manager.refresh(httpServer);
    await vi.waitFor(() => expect(clientState.closed).toBe(1));
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

  // 审计 D5：callTool 只带 timeout 不带 signal，用户点停止后 pi 仍要等 MCP 工具跑到超时（默认 120s，
  // 可配到 3600s），期间再发消息报 previous turn is still running；服务端也收不到取消
  it('用户中止时立即结束等待，并把中止交给 SDK 去取消请求', async () => {
    clientState.listTools = vi.fn(async () => ({
      tools: [{ name: 'search', inputSchema: { type: 'object' } }],
    }));
    // 服务端迟迟不回：不响应中止的话只能等到调用超时
    clientState.callTool = vi.fn(() => new Promise(() => {}));
    const { manager } = makeManager();
    const [tool] = await manager.toolsFor([httpServer]);
    const controller = new AbortController();
    const outcome = tool?.execute('tc-1', {}, controller.signal, undefined, {} as never).then(
      () => 'resolved',
      (error: Error) => error.message
    );
    controller.abort();
    const stillWaiting = new Promise((resolve) => setTimeout(() => resolve('still waiting'), 50));
    expect(await Promise.race([outcome, stillWaiting])).toMatch(/aborted/);
    const options = (clientState.callTool.mock.calls[0] as unknown[] | undefined)?.[2] as
      | { signal?: AbortSignal }
      | undefined;
    expect(options?.signal?.aborted).toBe(true);
  });

  it('forwards timeouts to SDK RequestOptions so the SDK 60s default does not win', async () => {
    clientState.connect = vi.fn(async () => {});
    clientState.listTools = vi.fn(async () => ({
      tools: [{ name: 'search', inputSchema: { type: 'object' } }],
    }));
    clientState.callTool = vi.fn(async () => ({ content: [{ type: 'text', text: 'ok' }] }));
    const { manager } = makeManager();
    const tools = await manager.toolsFor([
      { ...httpServer, connectTimeoutMs: 300_000, callTimeoutMs: 3_600_000 },
    ]);
    await tools[0]?.execute('tc-1', {}, undefined, undefined, {} as never);
    const argsOf = (fn: { mock: { calls: unknown[][] } }) => fn.mock.calls[0] ?? [];
    expect(argsOf(clientState.connect)[1]).toMatchObject({ timeout: 300_000 });
    expect(argsOf(clientState.listTools)[1]).toMatchObject({ timeout: 300_000 });
    expect(argsOf(clientState.callTool)[2]).toMatchObject({ timeout: 3_600_000 });
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

  it('maps MCP results for codemode: namespace, annotations, structuredContent, isError', async () => {
    clientState.listTools = vi.fn(async () => ({
      tools: [
        {
          name: 'search',
          inputSchema: { type: 'object' },
          annotations: { readOnlyHint: true, title: 'ignored' },
        },
      ],
    }));
    clientState.callTool = vi
      .fn()
      .mockResolvedValueOnce({
        content: [{ type: 'text', text: 'ok' }],
        structuredContent: { hits: 2 },
        _meta: { trace: 'x' },
      })
      .mockResolvedValueOnce({ content: [], isError: true });
    const { manager } = makeManager();
    const [tool] = await manager.toolsFor([httpServer]);
    expect(tool?.namespace?.name).toMatch(/^mcp__/);
    expect(tool?.annotations).toEqual({ readOnlyHint: true });
    expect(tool?.outputSchema).toMatchObject({ required: ['content'] });
    const ok = await tool?.execute('tc-1', {}, undefined, undefined, {} as never);
    expect(ok).toMatchObject({
      content: [{ type: 'text', text: 'ok' }],
      structuredContent: {
        content: [{ type: 'text', text: 'ok' }],
        structuredContent: { hits: 2 },
      },
    });
    expect(ok?.structuredContent).not.toHaveProperty('_meta');
    expect(ok).not.toHaveProperty('isError');
    const failed = await tool?.execute('tc-2', {}, undefined, undefined, {} as never);
    expect(failed).toMatchObject({ isError: true, structuredContent: { isError: true } });
    expect(failed?.content[0]).toMatchObject({
      type: 'text',
      text: expect.stringContaining('error'),
    });
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

describe('McpManager insufficient_scope', () => {
  it('传输层收到 insufficient_scope 挑战时上报 unauthorized 与所需 scope，响应原样返回', async () => {
    const { manager, events } = makeManager();
    await manager.toolsFor([httpServer]);
    const fetchFn = (transportState.http.at(-1)?.options as { fetch?: typeof fetch } | undefined)
      ?.fetch;
    expect(fetchFn).toBeTypeOf('function');
    const challenged = new Response('', {
      status: 403,
      headers: {
        'WWW-Authenticate':
          'Bearer error="insufficient_scope", scope="files:write", resource_metadata="https://mcp.notion.com/.well-known/oauth-protected-resource"',
      },
    });
    const original = globalThis.fetch;
    globalThis.fetch = vi.fn(async () => challenged) as never;
    try {
      expect(await fetchFn?.('https://mcp.notion.com/mcp')).toBe(challenged);
      globalThis.fetch = vi.fn(async () => new Response('', { status: 500 })) as never;
      await fetchFn?.('https://mcp.notion.com/mcp');
    } finally {
      globalThis.fetch = original;
    }
    const scoped = events.filter((event) => event.type === 'mcp-status' && event.scopeChallenge);
    expect(scoped).toEqual([
      expect.objectContaining({
        serverId: 'srv-1',
        state: 'unauthorized',
        scopeChallenge: {
          scope: 'files:write',
          resourceMetadataUrl: 'https://mcp.notion.com/.well-known/oauth-protected-resource',
        },
      }),
    ]);
  });
});

describe('McpManager insufficient_scope · 连接失败', () => {
  it('建连因 scope 不足失败时，最终状态保留挑战而不是被普通 error 覆盖', async () => {
    const original = globalThis.fetch;
    globalThis.fetch = vi.fn(
      async () =>
        new Response('', {
          status: 403,
          headers: { 'WWW-Authenticate': 'Bearer error="insufficient_scope", scope="files:write"' },
        })
    ) as never;
    clientState.connect = vi.fn(async () => {
      const options = transportState.http.at(-1)?.options as { fetch?: typeof fetch } | undefined;
      await options?.fetch?.('https://mcp.notion.com/mcp');
      throw new Error('HTTP 403: Invalid OAuth error response');
    });
    try {
      const { manager, events } = makeManager();
      const result = await manager.resolve({ ...httpServer, id: 'srv-scope' });
      expect(result).toMatchObject({ ok: false, unauthorized: true });
      expect(events.at(-1)).toMatchObject({
        type: 'mcp-status',
        state: 'unauthorized',
        scopeChallenge: { scope: 'files:write' },
      });
    } finally {
      globalThis.fetch = original;
    }
  });
});

describe('McpManager 插件调用', () => {
  const bce: McpServerSpawnConfig = { name: 'bce', transport: 'stdio', command: 'bce-tool' };
  beforeEach(() => {
    clientState.listTools = vi.fn(async () => ({
      tools: [
        { name: 'enhance_prompt', description: '改写提示词', inputSchema: { type: 'object' } },
        { name: 'search_context', inputSchema: { type: 'object' } },
      ],
    }));
  });

  it('按原始工具名列出各服务的工具', async () => {
    const { manager } = makeManager();
    await expect(manager.pluginTools([bce])).resolves.toEqual([
      { server: 'bce', name: 'enhance_prompt', description: '改写提示词' },
      { server: 'bce', name: 'search_context', description: '' },
    ]);
  });

  it('按服务名与原始工具名调用，返回拼好的文本', async () => {
    clientState.callTool = vi.fn(async () => ({
      content: [
        { type: 'text', text: 'line 1' },
        { type: 'text', text: 'line 2' },
      ],
    }));
    const { manager } = makeManager();
    const result = await manager.callPluginTool(
      [bce],
      'bce',
      'enhance_prompt',
      { prompt: 'x' },
      new AbortController().signal
    );
    expect(result).toEqual({ content: 'line 1\nline 2', isError: false });
    expect(clientState.callTool).toHaveBeenCalledWith(
      { name: 'enhance_prompt', arguments: { prompt: 'x' } },
      undefined,
      expect.anything()
    );
  });

  it('服务或工具不存在时报错', async () => {
    const { manager } = makeManager();
    const signal = new AbortController().signal;
    await expect(
      manager.callPluginTool([bce], 'other', 'enhance_prompt', {}, signal)
    ).rejects.toThrow(/other/);
    await expect(manager.callPluginTool([bce], 'bce', 'missing', {}, signal)).rejects.toThrow(
      /missing/
    );
  });

  it('中止信号让调用立即失败', async () => {
    clientState.callTool = vi.fn(() => new Promise(() => {})) as never;
    const { manager } = makeManager();
    const controller = new AbortController();
    const pending = manager.callPluginTool([bce], 'bce', 'enhance_prompt', {}, controller.signal);
    await new Promise((r) => setTimeout(r, 10));
    controller.abort();
    await expect(pending).rejects.toThrow(/abort/i);
  });
});
