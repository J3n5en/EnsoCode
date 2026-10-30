import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import { extractWWWAuthenticateParams } from '@modelcontextprotocol/sdk/client/auth.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { MCP_OAUTH_REFRESH_SKEW_MS, mcpOAuthFingerprint } from '@shared/mcpOAuth';
import {
  DEFAULT_MCP_CALL_TIMEOUT_MS,
  DEFAULT_MCP_CONNECT_TIMEOUT_MS,
  mcpTimeoutMsOrDefault,
} from '@shared/mcpTimeout';
import type {
  McpConnectionState,
  McpOAuthAccess,
  McpOAuthRefreshResult,
  McpScopeChallenge,
  McpServerSpawnConfig,
  McpWorkerEvent,
} from '@shared/types/agent';
import { assignMcpToolNames, mcpNamespaceName, oneLine } from './mcpNames';

const INSTRUCTIONS_MAX = 2000;

interface Connection {
  client: Client;
  tools: ToolDefinition[];
}

export interface McpManagerOptions {
  emit(event: McpWorkerEvent): void;
  /** 请 Main 续期 access token（refresh_token 只在 Main）；rejected = 被拒 token 的指纹 */
  refreshOAuth?(serverId: string, rejected?: string): Promise<McpOAuthRefreshResult>;
}

/**
 * worker 侧 OAuth 凭据：只持 access token，临期或被拒时请 Main 续期，同一 token 只续一次。
 * 被续期淘汰的旧 token 记为 retired：spawn 时冻结的会话配置回传它时不回退。
 */
class OAuthAccess {
  current: McpOAuthAccess | undefined;
  private readonly retired = new Set<string>();
  private renewing: { rejected: string; promise: Promise<McpOAuthAccess | undefined> } | undefined;
  private proactiveFailed = '';

  constructor(
    private readonly renewer: ((rejected: string) => Promise<McpOAuthRefreshResult>) | undefined,
    private readonly onRenewed: (access: McpOAuthAccess) => void
  ) {}

  isRetired(access: McpOAuthAccess | undefined): boolean {
    return Boolean(access && this.retired.has(oauthFingerprint(access)));
  }

  /** Main 下发的凭据（重新授权 / 撤销）：已淘汰的旧 token 忽略 */
  offer(access: McpOAuthAccess | undefined): void {
    if (!this.isRetired(access)) this.current = access;
  }

  /** 发请求前取 token：临期先续期；续期失败仍用旧 token，交给服务端裁决 */
  async forRequest(): Promise<McpOAuthAccess | undefined> {
    const access = this.current;
    if (!access?.expires_at || Date.now() < access.expires_at - MCP_OAUTH_REFRESH_SKEW_MS) {
      return access;
    }
    const fingerprint = oauthFingerprint(access);
    if (this.proactiveFailed === fingerprint) return access;
    const next = await this.renew(access);
    if (!next) this.proactiveFailed = fingerprint;
    return next ?? access;
  }

  /** 该 token 已不可用：别处已换过就直接用新的，否则请 Main 续期 */
  renew(stale: McpOAuthAccess): Promise<McpOAuthAccess | undefined> {
    const rejected = oauthFingerprint(stale);
    if (this.current && oauthFingerprint(this.current) !== rejected) {
      return Promise.resolve(this.current);
    }
    if (!this.renewer) return Promise.resolve(undefined);
    if (this.renewing?.rejected === rejected) return this.renewing.promise;
    const promise = this.renewer(rejected)
      .then(
        (result) => {
          if (!result.ok || oauthFingerprint(result.access) === rejected) return undefined;
          this.retired.add(rejected);
          this.current = result.access;
          this.onRenewed(result.access);
          return result.access;
        },
        () => undefined
      )
      .finally(() => {
        if (this.renewing?.promise === promise) this.renewing = undefined;
      });
    this.renewing = { rejected, promise };
    return promise;
  }
}

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** 续期后仍 401（SDK 的 StreamableHTTPError / SseError 带 code）归为「需要用户去设置页授权」 */
const isUnauthorized = (error: unknown): boolean =>
  (typeof error === 'object' && error !== null && 'code' in error && error.code === 401) ||
  /\b401\b|unauthorized/i.test(errorMessage(error));

const RETRIABLE_CONNECTION_PATTERNS = [
  'not connected',
  'transport not connected',
  'transport closed',
  'econnrefused',
  'econnreset',
  'epipe',
  'enetunreach',
  'ehostunreach',
  'fetch failed',
  'network error',
];

/** 401/403 带 insufficient_scope：所需 scope 与资源元数据（续期拿不到新 scope，只能重新授权） */
function scopeChallengeOf(response: Response): McpScopeChallenge | undefined {
  if (response.status !== 401 && response.status !== 403) return undefined;
  const { error, scope, resourceMetadataUrl } = extractWWWAuthenticateParams(response);
  if (error !== 'insufficient_scope') return undefined;
  return {
    ...(scope ? { scope } : {}),
    ...(resourceMetadataUrl ? { resourceMetadataUrl: resourceMetadataUrl.href } : {}),
  };
}

const withBearer = (init: RequestInit | undefined, access: McpOAuthAccess): RequestInit => {
  const headers = new Headers(init?.headers);
  headers.set('Authorization', `Bearer ${access.access_token}`);
  return { ...init, headers };
};

/**
 * 远程 MCP 的 fetch：注入 access token，401 时请 Main 续期并重试一次；用户自配 Authorization 头优先。
 * scope 挑战回报给 Main，响应原样交回 SDK。
 */
function remoteFetch(
  access: OAuthAccess,
  onChallenge: (challenge: McpScopeChallenge) => void
): typeof fetch {
  return async (input, init) => {
    let response: Response;
    if (new Headers(init?.headers).has('authorization')) {
      response = await fetch(input, init);
    } else {
      const send = (token: McpOAuthAccess | undefined) =>
        fetch(input, token ? withBearer(init, token) : init);
      const token = await access.forRequest();
      response = await send(token);
      if (response.status === 401 && token && !scopeChallengeOf(response)) {
        const next = await access.renew(token);
        if (next) {
          await response.body?.cancel().catch(() => {});
          response = await send(next);
        }
      }
    }
    const challenge = scopeChallengeOf(response);
    if (challenge) onChallenge(challenge);
    return response;
  };
}

/** 死连接 / 过期 session：值得清缓存并重试一次。业务错误和 401 不走这条。 */
export function isRetriableMcpConnectionError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const message = error.message.toLowerCase();
  if (/^http (404|502|503):/.test(message)) return true;
  return RETRIABLE_CONNECTION_PATTERNS.some((pattern) => message.includes(pattern));
}

const connectionKey = (server: McpServerSpawnConfig): string =>
  JSON.stringify([
    server.id,
    server.transport,
    server.command,
    server.args,
    server.env,
    server.url,
    ...(server.headers ? [server.headers] : []),
  ]);

/** token 指纹：token 明文不入内存索引，只用 hash 前缀判断「Main 是否换了下发的 token」 */
export const oauthFingerprint = (access: McpOAuthAccess | undefined): string =>
  access?.access_token ? mcpOAuthFingerprint(access.access_token) : '';

type McpJson = NonNullable<Awaited<ReturnType<ToolDefinition['execute']>>['structuredContent']>;

/** codemode 脚本拿到的 CallToolResult 形状（与 pi 内置 MCP 一致） */
const mcpResultSchema = (structuredContent: unknown) => ({
  type: 'object',
  properties: {
    content: { type: 'array', items: { type: 'object' } },
    ...(structuredContent && typeof structuredContent === 'object' ? { structuredContent } : {}),
    isError: { type: 'boolean' },
  },
  required: ['content'],
});

const ANNOTATION_HINTS = [
  'readOnlyHint',
  'destructiveHint',
  'idempotentHint',
  'openWorldHint',
] as const;

function toAnnotations(raw: unknown): ToolDefinition['annotations'] {
  if (!raw || typeof raw !== 'object') return undefined;
  const annotations: NonNullable<ToolDefinition['annotations']> = {};
  for (const hint of ANNOTATION_HINTS) {
    const value = (raw as Record<string, unknown>)[hint];
    if (typeof value === 'boolean') annotations[hint] = value;
  }
  return Object.keys(annotations).length > 0 ? annotations : undefined;
}

export type McpServerResolution =
  | { ok: true; tools: ToolDefinition[] }
  | { ok: false; error: string; unauthorized: boolean };

function mapToolResult(
  result: unknown,
  name: string
): {
  content: Array<
    { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }
  >;
  details: undefined;
  structuredContent: McpJson;
  isError?: true;
} {
  const payload =
    result && typeof result === 'object'
      ? (result as { content?: unknown; isError?: boolean; _meta?: unknown })
      : {};
  const content = (Array.isArray(payload.content) ? payload.content : []).map(
    (part: { type: string; text?: string; data?: string; mimeType?: string }) => {
      if (part.type === 'text') return { type: 'text' as const, text: part.text ?? '' };
      if (part.type === 'image' && part.data && part.mimeType) {
        return { type: 'image' as const, data: part.data, mimeType: part.mimeType };
      }
      return { type: 'text' as const, text: JSON.stringify(part) };
    }
  );
  const { _meta: _ignored, ...structuredContent } = payload;
  const hasText = content.some((part) => part.type === 'text' && part.text);
  if (payload.isError && !hasText) {
    content.push({ type: 'text' as const, text: `MCP tool ${name} returned an error` });
  }
  return {
    content: content.length > 0 ? content : [{ type: 'text' as const, text: '' }],
    details: undefined,
    structuredContent: {
      ...structuredContent,
      content: payload.content ?? [],
    } as unknown as McpJson,
    ...(payload.isError ? { isError: true as const } : {}),
  };
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

/**
 * MCP 连接管理：worker 级共享，按配置签名缓存（同配置只建一条连接，多会话复用）。
 * 连接保活到 worker 退出（closeAll）；不做引用计数，泄漏面由 worker 生命周期兜底。
 */
const MCP_FAIL_TTL_MS = 15_000;

export class McpManager {
  private readonly connections = new Map<string, Promise<Connection | null>>();
  /** 每条连接最近一次被下发的 token 指纹，用来区分「换了凭据」与「回传了旧凭据」 */
  private readonly dispatched = new Map<string, string>();
  /** 同 server 并发 stale 调用合并成一次重连 */
  private readonly reconnecting = new Map<string, Promise<Connection | null>>();
  /** 失败短时负缓存：同凭据在 TTL 内不再打连接 */
  private readonly failedUntil = new Map<
    string,
    { until: number; fingerprint: string; error: string; unauthorized: boolean }
  >();
  /** 最近一次下发的凭据：按需 server 的会话配置在 spawn 时冻结，连接时以它为准 */
  private readonly latestOAuth = new Map<string, McpOAuthAccess | undefined>();
  /** 每个连接签名的凭据持有方，跨重连保留（retired 记录不能丢） */
  private readonly oauth = new Map<string, OAuthAccess>();
  /** 最近一次 insufficient_scope 挑战：建连随后失败时据此报「需授权」而非普通错误 */
  private readonly scopeChallenges = new Map<string, McpScopeChallenge>();

  constructor(private readonly options: McpManagerOptions = { emit: () => {} }) {}

  /**
   * 为一组 server 配置解析工具列表；单个 server 失败只跳过并留痕，不抛。
   * budgetMs：spawn 场景的等待预算——超时的 server 本次不注入，连接在后台继续
   * （缓存保留），下次 spawn 即命中；不给则等到连接结束（预热场景）。
   */
  async toolsFor(servers: McpServerSpawnConfig[], budgetMs?: number): Promise<ToolDefinition[]> {
    const results = await Promise.all(
      servers.map((server) => {
        const pending = this.connectionFor(server);
        if (budgetMs === undefined) return pending;
        return Promise.race([
          pending,
          new Promise<null>((resolve) => setTimeout(() => resolve(null), budgetMs)),
        ]);
      })
    );
    return results.flatMap((connection) => connection?.tools ?? []);
  }

  /** 按需连接单个 server（代理工具用）：以最近下发的凭据为准，失败带原因 */
  async resolve(server: McpServerSpawnConfig): Promise<McpServerResolution> {
    const current = this.withLatestOAuth(server);
    const connection = await this.connectionFor(current);
    if (connection) return { ok: true, tools: connection.tools };
    const failed = this.failedUntil.get(connectionKey(current));
    return {
      ok: false,
      error: failed?.error ?? 'connection failed',
      unauthorized: failed?.unauthorized ?? false,
    };
  }

  /** 按需 server 的预热：记下凭据，只把换 token / 撤销同步给已建立的连接，不新连 */
  refresh(dispatched: McpServerSpawnConfig): void {
    const key = connectionKey(dispatched);
    const server = this.withoutRetired(key, dispatched);
    this.latestOAuth.set(key, server.oauth);
    if (this.connections.has(key)) void this.connectionFor(server);
  }

  private withLatestOAuth(server: McpServerSpawnConfig): McpServerSpawnConfig {
    const key = connectionKey(server);
    if (!this.latestOAuth.has(key)) return server;
    const { oauth: _frozen, ...rest } = server;
    const oauth = this.latestOAuth.get(key);
    return oauth ? { ...rest, oauth } : rest;
  }

  /** 冻结配置带着已被续期淘汰的 token：换成当前 token，不回退 */
  private withoutRetired(key: string, server: McpServerSpawnConfig): McpServerSpawnConfig {
    const access = this.oauth.get(key);
    if (!access?.isRetired(server.oauth)) return server;
    const { oauth: _retired, ...rest } = server;
    return access.current ? { ...rest, oauth: access.current } : rest;
  }

  private oauthFor(key: string, server: McpServerSpawnConfig): OAuthAccess {
    let access = this.oauth.get(key);
    if (!access) {
      const { id } = server;
      const { refreshOAuth } = this.options;
      const renewer =
        id && refreshOAuth ? (rejected: string) => refreshOAuth(id, rejected) : undefined;
      access = new OAuthAccess(renewer, (renewed) => {
        this.latestOAuth.set(key, renewed);
        this.dispatched.set(key, oauthFingerprint(renewed));
        this.failedUntil.delete(key);
      });
      this.oauth.set(key, access);
    }
    return access;
  }

  private connectionFor(dispatched: McpServerSpawnConfig): Promise<Connection | null> {
    const key = connectionKey(dispatched);
    const server = this.withoutRetired(key, dispatched);
    const fingerprint = oauthFingerprint(server.oauth);
    this.latestOAuth.set(key, server.oauth);
    const failed = this.failedUntil.get(key);
    if (failed && failed.fingerprint !== fingerprint) this.failedUntil.delete(key);
    else if (failed && Date.now() < failed.until) return Promise.resolve(null);
    let pending = this.connections.get(key);
    if (pending) pending = this.applyDispatchedTokens(key, server, pending);
    if (!pending) {
      pending = this.connect(server).catch((error) => {
        console.error(`[mcp] connect failed for "${server.name}":`, error);
        const challenge = this.scopeChallenges.get(key);
        const unauthorized = Boolean(challenge) || isUnauthorized(error);
        const message = errorMessage(error);
        this.emitStatus(server, unauthorized ? 'unauthorized' : 'error', {
          error: message,
          ...(challenge ? { scopeChallenge: challenge } : {}),
        });
        this.connections.delete(key);
        this.failedUntil.set(key, {
          until: Date.now() + MCP_FAIL_TTL_MS,
          fingerprint,
          error: message,
          unauthorized,
        });
        return null;
      });
      this.connections.set(key, pending);
    }
    this.dispatched.set(key, fingerprint);
    return pending;
  }

  private reconnect(server: McpServerSpawnConfig, stale: Client): Promise<Connection | null> {
    const key = connectionKey(server);
    const pending = this.reconnecting.get(key);
    if (pending) return pending;
    const attempt = this.doReconnect(key, server, stale).finally(() => {
      this.reconnecting.delete(key);
    });
    this.reconnecting.set(key, attempt);
    return attempt;
  }

  private async doReconnect(
    key: string,
    server: McpServerSpawnConfig,
    stale: Client
  ): Promise<Connection | null> {
    const current = this.connections.get(key);
    if (current) {
      const resolved = await current;
      if (resolved && resolved.client !== stale) return resolved;
    }
    this.connections.delete(key);
    this.dispatched.delete(key);
    await stale.close().catch(() => {});
    return this.connectionFor(server);
  }

  /**
   * Main 下发的凭据与上次不同时：换新 token 只原地更新凭据——已跑会话的工具闭包
   * 捕获着这个 client，为换 token 重建连接等于弄坏它们；只有撤销（不再下发凭据）才下线重建。
   * 指纹与上次相同则是回传旧凭据，忽略。
   */
  private applyDispatchedTokens(
    key: string,
    server: McpServerSpawnConfig,
    pending: Promise<Connection | null>
  ): Promise<Connection | null> | undefined {
    const previous = this.dispatched.get(key);
    const fingerprint = oauthFingerprint(server.oauth);
    if (previous === undefined || previous === fingerprint) return pending;
    if (!server.oauth) {
      this.connections.delete(key);
      this.failedUntil.delete(key);
      void pending.then((connection) => connection?.client.close().catch(() => {}));
      return undefined;
    }
    this.failedUntil.delete(key);
    this.oauth.get(key)?.offer(server.oauth);
    return pending;
  }

  /** worker 不能开浏览器：把挑战交给 Main，由用户重新授权时在已授予 scope 上追加 */
  private reportScopeChallenge(server: McpServerSpawnConfig, challenge: McpScopeChallenge): void {
    this.scopeChallenges.set(connectionKey(server), challenge);
    this.emitStatus(server, 'unauthorized', {
      error: `MCP server requires additional scope${challenge.scope ? `: ${challenge.scope}` : ''}`,
      scopeChallenge: challenge,
    });
  }

  private emitStatus(
    server: McpServerSpawnConfig,
    state: McpConnectionState,
    extra?: { toolCount?: number; error?: string; scopeChallenge?: McpScopeChallenge }
  ): void {
    this.options.emit({
      type: 'mcp-status',
      ...(server.id ? { serverId: server.id } : {}),
      serverName: server.name,
      state,
      ...extra,
    });
  }

  private async connect(server: McpServerSpawnConfig): Promise<Connection> {
    this.emitStatus(server, 'connecting');
    const client = new Client({ name: 'enso-code', version: '0.1.0' });
    let tools: Awaited<ReturnType<Client['listTools']>>['tools'];
    const connectTimeoutMs = mcpTimeoutMsOrDefault(
      server.connectTimeoutMs,
      DEFAULT_MCP_CONNECT_TIMEOUT_MS
    );
    const callTimeoutMs = mcpTimeoutMsOrDefault(server.callTimeoutMs, DEFAULT_MCP_CALL_TIMEOUT_MS);
    try {
      await withTimeout(
        client.connect(this.createTransport(server), { timeout: connectTimeoutMs }),
        connectTimeoutMs,
        `connect ${server.name}`
      );
      ({ tools } = await withTimeout(
        client.listTools(undefined, { timeout: connectTimeoutMs }),
        connectTimeoutMs,
        `listTools ${server.name}`
      ));
    } catch (error) {
      // 不 close 的话 stdio 子进程会随每次重试累积
      await client.close().catch(() => {});
      throw error;
    }
    this.scopeChallenges.delete(connectionKey(server));
    this.emitStatus(server, 'ready', { toolCount: tools.length });
    // 同 Claude Code：server instructions 进 system prompt；挂在每个工具上，pi 按文本去重，
    // 只渲染已激活工具的 guideline，按需（deferred）server 不会进 prompt
    const instructions = oneLine(client.getInstructions() ?? '', INSTRUCTIONS_MAX);
    const promptGuidelines = instructions
      ? [`${mcpNamespaceName(server.name)} server instructions: ${instructions}`]
      : undefined;
    return {
      client,
      tools: (() => {
        const names = assignMcpToolNames(
          server.name,
          tools.map((tool) => tool.name)
        );
        return tools.map((tool, index) => ({
          ...this.toToolDefinition(client, server, tool, names[index], callTimeoutMs),
          ...(promptGuidelines ? { promptGuidelines } : {}),
        }));
      })(),
    };
  }

  private remoteFetchFor(server: McpServerSpawnConfig): typeof fetch {
    const access = this.oauthFor(connectionKey(server), server);
    access.offer(server.oauth);
    return remoteFetch(access, (challenge) => this.reportScopeChallenge(server, challenge));
  }

  private createTransport(server: McpServerSpawnConfig) {
    switch (server.transport) {
      case 'stdio': {
        if (!server.command) throw new Error('stdio server missing command');
        return new StdioClientTransport({
          command: server.command,
          args: server.args ?? [],
          // 不带 process.env 的话子进程连 PATH 都没有
          env: { ...(process.env as Record<string, string>), ...(server.env ?? {}) },
        });
      }
      case 'http': {
        if (!server.url) throw new Error('http server missing url');
        return new StreamableHTTPClientTransport(new URL(server.url), {
          fetch: this.remoteFetchFor(server),
          ...(server.headers ? { requestInit: { headers: server.headers } } : {}),
        });
      }
      case 'sse': {
        if (!server.url) throw new Error('sse server missing url');
        return new SSEClientTransport(new URL(server.url), {
          fetch: this.remoteFetchFor(server),
          ...(server.headers ? { requestInit: { headers: server.headers } } : {}),
        });
      }
      default:
        throw new Error(`unknown transport: ${server.transport}`);
    }
  }

  private toToolDefinition(
    client: Client,
    server: McpServerSpawnConfig,
    tool: {
      name: string;
      description?: string;
      inputSchema: unknown;
      outputSchema?: unknown;
      annotations?: unknown;
    },
    name: string,
    callTimeoutMs: number
  ): ToolDefinition {
    let active = client;
    const invoke = (target: Client, params: unknown) =>
      withTimeout(
        // SDK 内部请求默认 60s 超时，必须显式传入，否则外层 withTimeout 永远轮不到
        target.callTool(
          {
            name: tool.name,
            arguments: (params ?? {}) as Record<string, unknown>,
          },
          undefined,
          { timeout: callTimeoutMs }
        ),
        callTimeoutMs,
        `callTool ${name}`
      );
    const annotations = toAnnotations(tool.annotations);
    return {
      name,
      label: `${server.name}: ${tool.name}`,
      description: tool.description ?? `MCP tool ${tool.name} from ${server.name}`,
      // MCP inputSchema 是标准 JSON Schema，TypeBox 的 TSchema 结构同源，直接透传
      parameters: tool.inputSchema as ToolDefinition['parameters'],
      outputSchema: mcpResultSchema(tool.outputSchema) as ToolDefinition['outputSchema'],
      namespace: {
        name: mcpNamespaceName(server.name),
        description: server.description || server.name,
      },
      ...(annotations ? { annotations } : {}),
      execute: async (_toolCallId, params) => {
        try {
          return mapToolResult(await invoke(active, params), name);
        } catch (error) {
          if (!isRetriableMcpConnectionError(error)) throw error;
          const next = await this.reconnect(server, active);
          if (!next) throw error;
          active = next.client;
          return mapToolResult(await invoke(active, params), name);
        }
      },
    };
  }

  /** worker 退出前断开全部连接（stdio 子进程随之终止） */
  async closeAll(): Promise<void> {
    const pending = [...this.connections.values()];
    this.connections.clear();
    await Promise.allSettled(
      pending.map(async (entry) => {
        const connection = await entry;
        await connection?.client.close();
      })
    );
  }
}
