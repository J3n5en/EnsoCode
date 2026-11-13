import { randomBytes } from 'node:crypto';
import {
  authorizeMcp,
  type OAuthClientInformationMixed,
  type OAuthClientMetadata,
  type OAuthClientProvider,
  type OAuthFlowOptions,
  type OAuthFlowResult,
  type OAuthTokens,
  stepUpScope,
} from '@earendil-works/pi-mcp/oauth';
import { shell } from '@platform';
import {
  type OauthCallbackServer,
  type OauthCallbackServerOptions,
  startOauthCallbackServer,
} from '@shared/providers/callbackServer';
import type { McpOAuthTokens, McpScopeChallenge } from '@shared/types/agent';
import { MCP_TRANSPORTS, type McpServerEntry } from '@shared/types/assets';
import { readSettings } from '../ipc/settings';
import { getMcpOAuthStore, type McpOAuthStore } from './mcpOAuthStore';
import { mcpStatusFor } from './mcpStatusCache';

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
  /** 动态注册用的 client_name；缺省 Enso Code */
  clientName?: string;
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
      client_name: this.options.clientName || 'Enso Code',
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
    const client = this.options.store.record(this.options.serverId)?.clientInformation;
    // DCR 登记的是当次回调地址；首选端口被占用退到随机端口后，旧 client 会被严格比对 redirect_uri 的
    // 授权服务器拒绝，返回 undefined 让流程按本次地址重新注册。登记列表为空（服务端没回）时无从判断，照旧复用
    const registered = client?.redirect_uris;
    if (
      Array.isArray(registered) &&
      registered.length > 0 &&
      !registered.includes(this.options.redirectUrl)
    ) {
      return undefined;
    }
    return client as OAuthClientInformationMixed | undefined;
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

  /** 流程遇 invalid_client / invalid_grant 时清掉对应凭据后重试 */
  invalidateCredentials(kind: 'all' | 'client' | 'tokens' | 'verifier' | 'discovery'): void {
    if (kind === 'tokens') this.options.store.clearTokens(this.options.serverId);
    else if (kind === 'all' || kind === 'client') this.options.store.clear(this.options.serverId);
    else if (kind === 'verifier') this.verifier = undefined;
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
  ) =>
    | McpServerEntry
    | Pick<
        McpServerEntry,
        'id' | 'name' | 'transport' | 'url' | 'oauthClientName' | 'oauthMetadataUrl'
      >
    | undefined;
  startCallbackServer: (options: OauthCallbackServerOptions) => Promise<OauthCallbackServer>;
  /** pi 的 MCP OAuth 流程：RFC 9207 iss 校验、指定授权服务器元数据、step-up scope */
  auth: (provider: OAuthClientProvider, options: OAuthFlowOptions) => Promise<OAuthFlowResult>;
  /** worker 上报的 insufficient_scope 挑战；有则本次授权在已授予 scope 上追加 */
  scopeChallenge?: (serverId: string) => McpScopeChallenge | undefined;
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
    auth: authorizeMcp,
    scopeChallenge: (serverId) => mcpStatusFor(serverId)?.scopeChallenge,
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
  const responsePromise = callback.waitForResponse();
  responsePromise.catch(() => {});

  // 重新授权前清掉失效 token（否则 SDK 先走 refresh，invalid_grant 直接抛错）；
  // 用户中途取消时再放回去，避免把原本可用的凭据弄没
  const previous = deps.store.record(serverId);
  const previousTokens = previous?.tokens;
  const challenge = deps.scopeChallenge?.(serverId);
  let authorized = false;
  try {
    deps.store.clearTokens(serverId);
    const provider = new McpOAuthClientProvider({
      serverId,
      serverUrl,
      redirectUrl: callback.redirectUri,
      state,
      store: deps.store,
      openExternal: deps.openExternal,
      ...(server.oauthClientName?.trim() ? { clientName: server.oauthClientName.trim() } : {}),
    });
    const flow: OAuthFlowOptions = {
      serverUrl,
      ...(server.oauthMetadataUrl?.trim()
        ? { authorizationServerMetadataUrl: new URL(server.oauthMetadataUrl.trim()) }
        : {}),
      ...(challenge
        ? {
            // 挑战可能只列缺的 scope：叠加已授予的，否则新 token 会丢掉原有权限；刷新拿不到新 scope
            scope: stepUpScope(previousTokens?.scope, challenge.scope),
            skipRefresh: true,
            ...(challenge.resourceMetadataUrl
              ? { resourceMetadataUrl: new URL(challenge.resourceMetadataUrl) }
              : {}),
          }
        : {}),
    };
    // 首轮：完成 discovery/DCR，需要交互时经 redirectToAuthorization 打开浏览器
    let result = await deps.auth(provider, flow);
    if (result === 'REDIRECT') {
      const { code, iss } = await responsePromise;
      result = await deps.auth(provider, {
        ...flow,
        authorizationCode: code,
        ...(iss ? { iss } : {}),
      });
    }
    if (result !== 'AUTHORIZED') return { ok: false, error: '授权未完成。' };
    authorized = true;
    deps.onAuthorized?.(serverId);
    return { ok: true };
  } catch (error) {
    return { ok: false, error: message(error) };
  } finally {
    if (!authorized && previous?.tokens && !deps.store.tokens(serverId)) {
      // 整条原样放回：saveTokens 会按 expires_in 重算，把快过期的 token 续成满额而跳过临期续期；
      // 流程中途还可能为新回调地址重新注册了 client，旧 token 只配旧 client
      deps.store.restore(serverId, previous);
    }
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
