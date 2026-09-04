import { randomBytes } from 'node:crypto';
import {
  type AuthResult,
  type OAuthClientProvider,
  auth as sdkAuth,
} from '@modelcontextprotocol/sdk/client/auth.js';
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js';
import {
  type OauthCallbackServer,
  type OauthCallbackServerOptions,
  startOauthCallbackServer,
} from '@shared/providers/callbackServer';
import type { McpOAuthTokens } from '@shared/types/agent';
import { MCP_TRANSPORTS, type McpServerEntry } from '@shared/types/assets';
import { shell } from 'electron';
import { readSettings } from '../ipc/settings';
import { getMcpOAuthStore, type McpOAuthStore } from './mcpOAuthStore';

/** 授权整体超时：含用户在浏览器里操作的时间 */
const AUTHORIZE_TIMEOUT_MS = 300_000;
const CALLBACK_PATH = '/mcp/oauth/callback';
/** 首选固定端口便于某些服务端白名单；被占用时回调服务器会自动退随机端口 */
const CALLBACK_PORT = 43117;

export interface McpOAuthProviderOptions {
  serverId: string;
  serverUrl: string;
  redirectUrl: string;
  state: string;
  store: McpOAuthStore;
  openExternal: (url: string) => void | Promise<void>;
}

/** MCP SDK 的 OAuthClientProvider 实现：持久化部分落 store，PKCE verifier 只活在本次流程内存 */
export class McpOAuthClientProvider implements OAuthClientProvider {
  private verifier?: string;

  constructor(private readonly options: McpOAuthProviderOptions) {}

  get redirectUrl(): string {
    return this.options.redirectUrl;
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: 'Enso Code',
      redirect_uris: [this.options.redirectUrl],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    };
  }

  state(): string {
    return this.options.state;
  }

  clientInformation(): OAuthClientInformationMixed | undefined {
    return this.options.store.record(this.options.serverId)?.clientInformation as
      | OAuthClientInformationMixed
      | undefined;
  }

  saveClientInformation(clientInformation: OAuthClientInformationMixed): void {
    this.options.store.saveClientInformation(
      this.options.serverId,
      clientInformation as unknown as Record<string, unknown>,
      this.options.serverUrl
    );
  }

  tokens(): OAuthTokens | undefined {
    return this.options.store.tokens(this.options.serverId) as OAuthTokens | undefined;
  }

  saveTokens(tokens: OAuthTokens): void {
    this.options.store.saveTokens(
      this.options.serverId,
      toStoredTokens(tokens),
      this.options.serverUrl
    );
  }

  async redirectToAuthorization(authorizationUrl: URL): Promise<void> {
    await this.options.openExternal(authorizationUrl.toString());
  }

  saveCodeVerifier(codeVerifier: string): void {
    this.verifier = codeVerifier;
  }

  codeVerifier(): string {
    if (!this.verifier) throw new Error('缺少 PKCE code verifier');
    return this.verifier;
  }
}

/** 只保留下发 worker 需要的字段，避免把服务端多余内容一起落盘 */
export function toStoredTokens(tokens: OAuthTokens | McpOAuthTokens): McpOAuthTokens {
  return {
    access_token: tokens.access_token,
    ...(tokens.token_type ? { token_type: tokens.token_type } : {}),
    ...(tokens.refresh_token ? { refresh_token: tokens.refresh_token } : {}),
    ...(typeof tokens.expires_in === 'number' ? { expires_in: tokens.expires_in } : {}),
    ...(tokens.scope ? { scope: tokens.scope } : {}),
  };
}

export interface AuthorizeDeps {
  store: McpOAuthStore;
  resolveServer: (
    serverId: string
  ) => McpServerEntry | Pick<McpServerEntry, 'id' | 'name' | 'transport' | 'url'> | undefined;
  startCallbackServer: (options: OauthCallbackServerOptions) => Promise<OauthCallbackServer>;
  auth: (
    provider: OAuthClientProvider,
    options: { serverUrl: string | URL; authorizationCode?: string }
  ) => Promise<AuthResult>;
  openExternal: (url: string) => void | Promise<void>;
  /** 授权成功后的回调：重新向 worker 下发 warm-mcp */
  onAuthorized?: (serverId: string) => void;
  timeoutMs?: number;
}

function defaultDeps(): AuthorizeDeps {
  return {
    store: getMcpOAuthStore(),
    resolveServer: resolveServerFromSettings,
    startCallbackServer: startOauthCallbackServer,
    auth: sdkAuth,
    openExternal: (url) => shell.openExternal(url),
  };
}

/** 从设置里按 id 找 MCP server 条目 */
export function resolveServerFromSettings(serverId: string): McpServerEntry | undefined {
  const state = (
    readSettings()?.['enso-settings'] as { state?: Record<string, unknown> } | undefined
  )?.state;
  const servers = Array.isArray(state?.mcpServers) ? state.mcpServers : [];
  return servers.find(
    (server): server is McpServerEntry =>
      Boolean(server) &&
      typeof server === 'object' &&
      (server as McpServerEntry).id === serverId &&
      MCP_TRANSPORTS.includes((server as McpServerEntry).transport)
  );
}

/** 同一 server 的并发授权复用同一条流程，避免开出两个浏览器窗口 */
const inflight = new Map<string, Promise<{ ok: boolean; error?: string }>>();

export function authorizeMcpServer(
  serverId: string,
  overrides: Partial<AuthorizeDeps> = {}
): Promise<{ ok: boolean; error?: string }> {
  const existing = inflight.get(serverId);
  if (existing) return existing;
  const run = runAuthorize(serverId, { ...defaultDeps(), ...overrides }).finally(() => {
    inflight.delete(serverId);
  });
  inflight.set(serverId, run);
  return run;
}

async function runAuthorize(
  serverId: string,
  deps: AuthorizeDeps
): Promise<{ ok: boolean; error?: string }> {
  const server = deps.resolveServer(serverId);
  if (!server) return { ok: false, error: 'MCP server 不存在。' };
  if (server.transport === 'stdio' || !server.url) {
    return { ok: false, error: '仅远程 (http/sse) MCP server 支持 OAuth 授权。' };
  }
  const serverUrl = server.url;
  const state = randomBytes(16).toString('hex');
  let callback: OauthCallbackServer;
  try {
    callback = await deps.startCallbackServer({
      preferredPort: CALLBACK_PORT,
      callbackPath: CALLBACK_PATH,
      expectedState: state,
      timeoutMs: deps.timeoutMs ?? AUTHORIZE_TIMEOUT_MS,
    });
  } catch (error) {
    return { ok: false, error: message(error) };
  }

  // close() 会 reject 内部 promise：预挂 handler，否则不走 REDIRECT 分支时会出现无人接管的 rejection
  const codePromise = callback.waitForCode();
  codePromise.catch(() => {});

  try {
    // 失效的旧 token 会让 SDK 先走 refresh 并在 invalid_grant 上直接抛错，重新授权前先清掉
    deps.store.clearTokens(serverId);
    const provider = new McpOAuthClientProvider({
      serverId,
      serverUrl,
      redirectUrl: callback.redirectUri,
      state,
      store: deps.store,
      openExternal: deps.openExternal,
    });
    // 首轮：SDK 完成 discovery/DCR，需要交互时经 redirectToAuthorization 打开浏览器
    let result = await deps.auth(provider, { serverUrl });
    if (result === 'REDIRECT') {
      const code = await codePromise;
      result = await deps.auth(provider, { serverUrl, authorizationCode: code });
    }
    if (result !== 'AUTHORIZED') return { ok: false, error: '授权未完成。' };
    deps.onAuthorized?.(serverId);
    return { ok: true };
  } catch (error) {
    return { ok: false, error: message(error) };
  } finally {
    callback.close();
  }
}

function message(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 300);
}

/** 撤销本地凭据；服务端不做通知（多数 MCP server 未提供 revoke 端点） */
export function revokeMcpServer(serverId: string, store: McpOAuthStore = getMcpOAuthStore()): void {
  store.clear(serverId);
}
