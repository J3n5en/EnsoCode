/**
 * Google Antigravity 订阅 provider（Gemini 3.x / Claude 4.x / GPT-OSS，走 Cloud Code Assist）。
 *
 * 从 OMP（github.com/can1357/oh-my-pi，MIT）的 `@oh-my-pi/pi-ai` 改写而来：
 * - OAuth 主体 + 开通流程：`src/registry/oauth/google-antigravity.ts`、`google-oauth-shared.ts`
 * - 回调服务器：`src/registry/oauth/callback-server.ts`（Bun.serve → node:http，见 ./callbackServer.ts）
 * - 请求封装与 SSE 消费：`src/providers/google-gemini-cli.ts` + `google-shared.ts`（只取 antigravity 分支）
 * - 模型发现：`@oh-my-pi/pi-catalog/src/discovery/antigravity.ts`
 * - 额度窗口：`src/usage/google-antigravity.ts`
 *
 * OMP 是 pi 的 fork（17.x vs 本项目的 0.84.3），类型体系已分叉，所以是「读懂后改写」，
 * 不引入任何 `@oh-my-pi/*` 依赖；OMP 用的校验库 `@oh-my-pi/omptype` 也换成手写窄化函数。
 */
import { randomBytes, randomUUID } from 'node:crypto';
import type { OauthUsageWindow } from '@shared/types';
import { startOauthCallbackServer } from './callbackServer';
import {
  createEventStream,
  emptyUsage,
  type PiAssistantMessage,
  type PiContentBlock,
  type PiContext,
  type PiEventStream,
  type PiLoginCallbacks,
  type PiModel,
  type PiModelSpec,
  type PiOauthCredentials,
  type PiRefreshModelsContext,
  type PiStopReason,
  type PiStreamOptions,
  type PiTextContent,
  type PiThinkingContent,
  type PiTool,
  type PiToolCall,
  type ProviderConfigInput,
} from './piProviderTypes';

export const ANTIGRAVITY_PROVIDER_ID = 'google-antigravity';

/**
 * 自定义 api 标识。pi 的 provider composer 要求「注册 streamSimple 时必须给 api」
 * （`dist/core/provider-composer.js` 的 `validateExtensionProvider`），而且只有
 * `model.api === extension.api` 的模型才会走我们的 streamSimple。
 */
const ANTIGRAVITY_API_ID = 'google-antigravity-cca';

// client id / secret 直接照搬 OMP 的 base64 字面量（Antigravity 客户端自带的公开凭证）
const CLIENT_ID = atob(
  'MTA3MTAwNjA2MDU5MS10bWhzc2luMmgyMWxjcmUyMzV2dG9sb2poNGc0MDNlcC5hcHBzLmdvb2dsZXVzZXJjb250ZW50LmNvbQ=='
);
const CLIENT_SECRET = atob('R09DU1BYLUs1OEZXUjQ4NkxkTEoxbUxCOHNYQzR6NnFEQWY=');
const CALLBACK_PORT = 51121;
const CALLBACK_PATH = '/oauth-callback';

/** 后两个 scope 是 Antigravity 专有，缺了拿不到 Cloud Code Assist 权限 */
const SCOPES = [
  'https://www.googleapis.com/auth/cloud-platform',
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/userinfo.profile',
  'https://www.googleapis.com/auth/cclog',
  'https://www.googleapis.com/auth/experimentsandconfigs',
];

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const USERINFO_URL = 'https://www.googleapis.com/oauth2/v1/userinfo?alt=json';

export const ANTIGRAVITY_PRIMARY_ENDPOINT = 'https://daily-cloudcode-pa.googleapis.com';
export const ANTIGRAVITY_SANDBOX_ENDPOINT = 'https://daily-cloudcode-pa.sandbox.googleapis.com';
const ENDPOINTS = [ANTIGRAVITY_PRIMARY_ENDPOINT, ANTIGRAVITY_SANDBOX_ENDPOINT];

const FREE_TIER_ID = 'free-tier';
const ONBOARD_TIMEOUT_MS = 30_000;
const ONBOARD_POLL_INTERVAL_MS = 1_000;
const REQUEST_TIMEOUT_MS = 30_000;
/** 刷新提前量：access token 的 expires 落库时就减掉，pi 到点自然调 refreshToken */
const REFRESH_SKEW_MS = 60_000;
/** Cloud Code Assist 控制面请求的固定 metadata */
const LOAD_CODE_ASSIST_METADATA = { ideType: 'ANTIGRAVITY' };

// ---- User-Agent（后端按客户端版本门控模型，版本必须像真客户端）----

/** 抓包自真实 2.8.0 `antigravity/hub` 客户端，离线兜底用 */
export const DEFAULT_ANTIGRAVITY_VERSION = '2.8.0';
const VERSION_MANIFEST_URL =
  'https://antigravity-hub-auto-updater-974169037036.us-central1.run.app/manifest/latest-arm64-mac.yml';
const VERSION_FETCH_TIMEOUT_MS = 5_000;

let discoveredVersion: string | null = null;
let versionFetch: Promise<void> | null = null;

/** 从 electron-builder 的更新 manifest 里取版本号；没有合法 `version:` 行返回 null */
export function parseAntigravityManifestVersion(yamlText: string): string | null {
  for (const line of yamlText.split(/\r?\n/)) {
    const match = /^\s*version\s*:\s*(?:"([^"]*)"|'([^']*)'|([^\s#]+))\s*(?:#.*)?$/.exec(line);
    if (!match) continue;
    const version = (match[1] ?? match[2] ?? match[3] ?? '').trim();
    return /^\d+\.\d+\.\d+$/.test(version) ? version : null;
  }
  return null;
}

/** 探一次最新版本，成功后进程内缓存；失败静默（兜底版本仍然可用） */
async function ensureAntigravityVersion(
  fetcher: typeof fetch = fetch,
  signal?: AbortSignal
): Promise<void> {
  if (discoveredVersion) return;
  versionFetch ??= (async () => {
    try {
      const timeout = AbortSignal.timeout(VERSION_FETCH_TIMEOUT_MS);
      const response = await fetcher(VERSION_MANIFEST_URL, {
        headers: { 'Cache-Control': 'no-cache', 'User-Agent': 'electron-builder' },
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
      if (response.ok) discoveredVersion = parseAntigravityManifestVersion(await response.text());
    } catch {
      // 静默：拿不到就用 DEFAULT_ANTIGRAVITY_VERSION
    } finally {
      if (!discoveredVersion) versionFetch = null;
    }
  })();
  return versionFetch;
}

/**
 * `antigravity/hub/<version> (aidev_client; os_type=darwin; arch=arm64; cl=...)`
 * os_type/arch 固定成抓包时的 darwin/arm64 参考客户端，与本机平台无关；
 * 实测后端不校验 cl，只按 version 门控模型。
 */
function antigravityUserAgent(): string {
  const version = discoveredVersion ?? DEFAULT_ANTIGRAVITY_VERSION;
  return `antigravity/hub/${version} (aidev_client; os_type=darwin; arch=arm64; cl=963137146)`;
}

// ---- 凭证 ----

export interface AntigravityCredentials {
  access: string;
  refresh: string;
  expires: number;
  /** 刷新与推理都必需；pi 的 auth.json 校验只看 access/refresh/expires，不拒额外字段 */
  projectId: string;
  email?: string;
}

/**
 * 把 `expires_in`（秒）折算成落库的绝对过期时间，并预扣 60s 刷新提前量。
 * 与 pi 内置 OAuth flow 的写法一致（skew 烘进 expires，判定处直接比 now）。
 */
export function antigravityExpiryFromSeconds(expiresInSeconds: number, nowMs = Date.now()): number {
  return nowMs + expiresInSeconds * 1000 - REFRESH_SKEW_MS;
}

/** 到点即算过期（expires 已含 60s 提前量）；缺失过期时间保守视为过期 */
export function isAccessTokenExpired(expires: number | undefined, nowMs = Date.now()): boolean {
  if (typeof expires !== 'number' || !Number.isFinite(expires)) return true;
  return nowMs >= expires;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/**
 * 解出 streamSimple 拿到的凭证串（由 `getApiKey` 序列化）。
 * 脏输入（非 JSON / 缺字段）一律转成可读错误，不让 JSON.parse 的原始异常冒到界面。
 */
export function parseAntigravityApiKey(apiKeyRaw: string): AntigravityCredentials {
  let raw: unknown;
  try {
    raw = JSON.parse(apiKeyRaw);
  } catch {
    throw new Error('Antigravity 凭证不是合法 JSON，请重新登录');
  }
  if (!raw || typeof raw !== 'object') throw new Error('Antigravity 凭证格式不对，请重新登录');
  const record = raw as Record<string, unknown>;
  const access = optionalString(record.access);
  const projectId = optionalString(record.projectId);
  if (!access || !projectId)
    throw new Error('Antigravity 凭证缺少 access 或 projectId，请重新登录');
  return {
    access,
    refresh: optionalString(record.refresh) ?? '',
    expires: typeof record.expires === 'number' ? record.expires : 0,
    projectId,
    email: optionalString(record.email),
  };
}

// ---- HTTP 小工具 ----

/** 长度上限对齐 `src/main/services/providerApi.ts` 的 errorText */
const UPSTREAM_BODY_LIMIT = 300;

/** 看起来像凭证的片段：Authorization 头、token 字段、Google 的 ya29. 前缀、JWT */
const SECRET_PATTERNS: readonly [RegExp, string][] = [
  [/\b(Bearer|Basic)\s+[\w\-._~+/]+=*/gi, '$1 [已脱敏]'],
  [
    /"(access_token|refresh_token|id_token|client_secret|authorization|api_key|apikey)"\s*:\s*"[^"]*"/gi,
    '"$1": "[已脱敏]"',
  ],
  [
    /\b(access_token|refresh_token|id_token|client_secret|authorization|api_key|apikey)=[^&\s"]+/gi,
    '$1=[已脱敏]',
  ],
  [/\bya29\.[\w\-._~+/]+=*/g, '[已脱敏]'],
  [/\beyJ[\w-]+\.[\w-]+\.[\w-]+/g, '[已脱敏]'],
];

/**
 * 上游响应体必须先脱敏 + 截断才能进 `Error.message`。
 *
 * 这些错误会经 pi 的 `OauthLoginEvent.error` / worker 的 errorMessage 一路走到
 * 渲染层的登录框与聊天区，而 401 响应、企业代理的拦截页可能回显 Authorization
 * 头或几十 KB 的 HTML。所以先按整体脱敏（截断放最后，避免把 token 切成两半
 * 只脱敏掉前半截），再压掉换行、最后截到 300 字。
 */
export function sanitizeUpstreamBody(text: string): string {
  let safe = text;
  for (const [pattern, replacement] of SECRET_PATTERNS) safe = safe.replace(pattern, replacement);
  safe = safe.replace(/\s+/g, ' ').trim();
  return safe.length > UPSTREAM_BODY_LIMIT
    ? `${safe.slice(0, UPSTREAM_BODY_LIMIT)}…（已截断）`
    : safe;
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  signal?: AbortSignal,
  timeoutMs = REQUEST_TIMEOUT_MS
): Promise<Response> {
  const timeout = AbortSignal.timeout(timeoutMs);
  const composed = signal ? AbortSignal.any([signal, timeout]) : timeout;
  try {
    return await fetch(url, { ...init, signal: composed });
  } catch (error) {
    if (signal?.aborted) throw new Error('登录已取消');
    if (timeout.aborted) throw new Error(`请求 ${url} 超时（${timeoutMs}ms）`);
    throw error;
  }
}

async function postForm(
  url: string,
  body: URLSearchParams,
  signal?: AbortSignal
): Promise<Record<string, unknown>> {
  const response = await fetchWithTimeout(
    url,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    },
    signal
  );
  if (!response.ok) {
    const detail = sanitizeUpstreamBody(await response.text().catch(() => ''));
    throw new Error(`Google token 端点返回 ${response.status}${detail ? `: ${detail}` : ''}`);
  }
  return (await response.json()) as Record<string, unknown>;
}

function controlPlaneHeaders(accessToken: string): Record<string, string> {
  return {
    Authorization: `Bearer ${accessToken}`,
    'Content-Type': 'application/json',
    'User-Agent': antigravityUserAgent(),
  };
}

// ---- 开通流程（loadCodeAssist → 必要时 onboardUser + LRO 轮询）----

interface LoadCodeAssistResponse {
  currentTier?: unknown;
  paidTier?: unknown;
  allowedTiers?: { id?: string }[];
  ineligibleTiers?: { tierId?: string; reasonMessage?: string; validationUrl?: string }[];
  cloudaicompanionProject?: string;
}

async function callControlPlane(
  accessToken: string,
  path: string,
  method: 'GET' | 'POST',
  body: unknown,
  signal: AbortSignal | undefined,
  timeoutMs: number
): Promise<unknown> {
  const init: RequestInit = { method, headers: controlPlaneHeaders(accessToken) };
  if (body !== undefined) init.body = JSON.stringify(body);
  const response = await fetchWithTimeout(
    `${ANTIGRAVITY_PRIMARY_ENDPOINT}${path}`,
    init,
    signal,
    timeoutMs
  );
  if (!response.ok) {
    const detail = sanitizeUpstreamBody(await response.text().catch(() => ''));
    throw new Error(
      `${path} 失败：${response.status} ${response.statusText}${detail ? `: ${detail}` : ''}`
    );
  }
  return response.json();
}

function narrowLoadCodeAssist(payload: unknown): LoadCodeAssistResponse {
  if (!payload || typeof payload !== 'object') return {};
  const record = payload as Record<string, unknown>;
  return {
    currentTier: record.currentTier,
    paidTier: record.paidTier,
    allowedTiers: Array.isArray(record.allowedTiers)
      ? (record.allowedTiers.filter((tier) => tier && typeof tier === 'object') as {
          id?: string;
        }[])
      : undefined,
    ineligibleTiers: Array.isArray(record.ineligibleTiers)
      ? (record.ineligibleTiers.filter((tier) => tier && typeof tier === 'object') as {
          tierId?: string;
          reasonMessage?: string;
        }[])
      : undefined,
    cloudaicompanionProject: optionalString(record.cloudaicompanionProject),
  };
}

async function loadCodeAssist(
  accessToken: string,
  signal: AbortSignal | undefined
): Promise<LoadCodeAssistResponse> {
  let payload = narrowLoadCodeAssist(
    await callControlPlane(
      accessToken,
      '/v1internal:loadCodeAssist',
      'POST',
      { metadata: LOAD_CODE_ASSIST_METADATA },
      signal,
      REQUEST_TIMEOUT_MS
    )
  );
  // 没有 paidTier 但已有 project 时，带上 project 再问一次拿完整层级信息
  if (payload.paidTier === undefined || payload.paidTier === null) {
    const projectId = payload.cloudaicompanionProject;
    if (projectId) {
      payload = narrowLoadCodeAssist(
        await callControlPlane(
          accessToken,
          '/v1internal:loadCodeAssist',
          'POST',
          { cloudaicompanionProject: projectId, metadata: LOAD_CODE_ASSIST_METADATA },
          signal,
          REQUEST_TIMEOUT_MS
        )
      );
    }
  }
  return payload;
}

function assertFreeTierEligible(payload: LoadCodeAssistResponse): void {
  if (payload.allowedTiers?.some((tier) => tier.id === FREE_TIER_ID)) return;
  const blocked = payload.ineligibleTiers?.find((tier) => tier.tierId === FREE_TIER_ID);
  if (!blocked?.reasonMessage) return;
  const validation = blocked.validationUrl ? `\n${blocked.validationUrl}` : '';
  throw new Error(`${blocked.reasonMessage}${validation}`);
}

interface OnboardOperation {
  name?: string;
  done?: boolean;
  error?: { code?: number; message?: string } | null;
  response?: unknown;
}

function narrowOnboardOperation(payload: unknown): OnboardOperation {
  if (!payload || typeof payload !== 'object') return {};
  const record = payload as Record<string, unknown>;
  return {
    name: optionalString(record.name),
    done: typeof record.done === 'boolean' ? record.done : undefined,
    error:
      record.error && typeof record.error === 'object'
        ? (record.error as { code?: number; message?: string })
        : null,
    response: record.response,
  };
}

/** 30s 截止、1s 间隔轮询开通用的长任务 */
async function onboardUser(accessToken: string, signal: AbortSignal | undefined): Promise<void> {
  const deadline = Date.now() + ONBOARD_TIMEOUT_MS;
  const remaining = (): number => {
    const left = deadline - Date.now();
    if (left > 0) return left;
    throw new Error(`onboardUser 超时（${ONBOARD_TIMEOUT_MS}ms）`);
  };

  let operation = narrowOnboardOperation(
    await callControlPlane(
      accessToken,
      '/v1internal:onboardUser',
      'POST',
      { tierId: FREE_TIER_ID, metadata: LOAD_CODE_ASSIST_METADATA },
      signal,
      remaining()
    )
  );

  while (!operation.done) {
    await new Promise((resolve) =>
      setTimeout(resolve, Math.min(ONBOARD_POLL_INTERVAL_MS, remaining()))
    );
    if (signal?.aborted) throw new Error('登录已取消');
    if (!operation.name) throw new Error('onboardUser 返回的长任务没有 name，无法轮询');
    operation = narrowOnboardOperation(
      await callControlPlane(
        accessToken,
        `/v1internal/${operation.name}`,
        'GET',
        undefined,
        signal,
        remaining()
      )
    );
  }

  if (operation.error) {
    const detail = sanitizeUpstreamBody(operation.error.message ?? JSON.stringify(operation.error));
    throw new Error(`onboardUser 失败：${detail}`);
  }
  if (operation.response === undefined || operation.response === null) {
    throw new Error('onboardUser 完成但没有返回 response');
  }
}

async function discoverProject(
  accessToken: string,
  onProgress: ((message: string) => void) | undefined,
  signal: AbortSignal | undefined
): Promise<string> {
  onProgress?.('检查 Cloud Code Assist 账号状态…');
  const initial = await loadCodeAssist(accessToken, signal);
  assertFreeTierEligible(initial);
  if (initial.currentTier === undefined || initial.currentTier === null) {
    onProgress?.('开通 Antigravity 免费层…');
    await onboardUser(accessToken, signal);
  }
  onProgress?.('刷新 Cloud Code Assist 项目…');
  const refreshed = await loadCodeAssist(accessToken, signal);
  const projectId = refreshed.cloudaicompanionProject ?? initial.cloudaicompanionProject;
  if (!projectId) throw new Error('loadCodeAssist 没有返回 cloudaicompanionProject');
  return projectId;
}

// ---- 登录 / 刷新 ----

async function fetchUserEmail(
  accessToken: string,
  signal: AbortSignal | undefined
): Promise<string | undefined> {
  try {
    const response = await fetchWithTimeout(
      USERINFO_URL,
      { headers: { Authorization: `Bearer ${accessToken}` } },
      signal
    );
    if (!response.ok) return undefined;
    const data = (await response.json()) as { email?: unknown };
    return optionalString(data.email);
  } catch {
    // email 只是展示用，拿不到不影响登录
    return undefined;
  }
}

async function login(callbacks: PiLoginCallbacks): Promise<PiOauthCredentials> {
  const signal = callbacks.signal;
  const state = randomBytes(16).toString('hex');
  // 不用 PKCE：照搬 OMP 参考实现的 installed-app + client_secret 形态。
  // 整条 OAuth 链路无法自测（要用户浏览器），在唯一已知可用的实现上做未验证的偏离不划算。
  void ensureAntigravityVersion(fetch, signal);

  const server = await startOauthCallbackServer({
    preferredPort: CALLBACK_PORT,
    callbackPath: CALLBACK_PATH,
    expectedState: state,
    signal,
    onProgress: callbacks.onProgress,
  });

  let code: string;
  try {
    const params = new URLSearchParams({
      client_id: CLIENT_ID,
      response_type: 'code',
      redirect_uri: server.redirectUri,
      scope: SCOPES.join(' '),
      state,
      access_type: 'offline',
      prompt: 'consent',
    });
    callbacks.onAuth({
      url: `${AUTH_URL}?${params.toString()}`,
      instructions: '在浏览器里完成 Google 登录并授权 Antigravity。',
    });
    callbacks.onProgress?.('等待浏览器完成授权…');
    code = await server.waitForCode();
  } finally {
    server.close();
  }

  callbacks.onProgress?.('用授权码换取 token…');
  const tokens = await postForm(
    TOKEN_URL,
    new URLSearchParams({
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      code,
      grant_type: 'authorization_code',
      redirect_uri: server.redirectUri,
    }),
    signal
  );
  const access = optionalString(tokens.access_token);
  const refresh = optionalString(tokens.refresh_token);
  if (!access) throw new Error('Google 没有返回 access_token');
  if (!refresh) throw new Error('Google 没有返回 refresh_token，请重试并确认勾选了离线访问');

  const email = await fetchUserEmail(access, signal);
  const projectId = await discoverProject(access, callbacks.onProgress, signal);

  const credentials: AntigravityCredentials = {
    access,
    refresh,
    expires: antigravityExpiryFromSeconds(Number(tokens.expires_in) || 3600),
    projectId,
    ...(email ? { email } : {}),
  };
  return credentials as unknown as PiOauthCredentials;
}

async function refreshToken(
  credentials: PiOauthCredentials,
  signal: AbortSignal
): Promise<PiOauthCredentials> {
  const projectId = optionalString((credentials as Record<string, unknown>).projectId);
  if (!projectId) throw new Error('Antigravity 凭证缺少 projectId，请重新登录');

  const tokens = await postForm(
    TOKEN_URL,
    new URLSearchParams({
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      refresh_token: credentials.refresh,
      grant_type: 'refresh_token',
    }),
    signal
  );
  const access = optionalString(tokens.access_token);
  if (!access) throw new Error('Antigravity token 刷新没有返回 access_token');

  const refreshed: AntigravityCredentials = {
    access,
    refresh: optionalString(tokens.refresh_token) ?? credentials.refresh,
    expires: antigravityExpiryFromSeconds(Number(tokens.expires_in) || 3600),
    projectId,
    ...(optionalString((credentials as Record<string, unknown>).email)
      ? { email: optionalString((credentials as Record<string, unknown>).email) as string }
      : {}),
  };
  return refreshed as unknown as PiOauthCredentials;
}

// ---- 工具 schema 归一化 ----

/**
 * Cloud Code Assist 的 `parameters` 只吃 Google 那套阉割版 JSON Schema。
 * OMP 用的是 2300 行的通用 normalizer，这里只落地实际会踩到的几条：
 * 去掉 Google 不认的关键字、`const` → 单值 `enum`、`oneOf` → `anyOf`、
 * `type: [T, 'null']` → `type: T` + `nullable`、object 必须带 `properties`。
 */
const DROPPED_SCHEMA_KEYS: Record<string, true> = {
  $schema: true,
  $id: true,
  $comment: true,
  additionalProperties: true,
  patternProperties: true,
  unevaluatedProperties: true,
  examples: true,
  prefixItems: true,
  exclusiveMinimum: true,
  exclusiveMaximum: true,
  not: true,
};

export function normalizeToolSchema(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizeToolSchema);
  if (!value || typeof value !== 'object') return value;

  const out: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (DROPPED_SCHEMA_KEYS[key]) continue;
    if (key === 'const') {
      out.enum = [raw];
      continue;
    }
    if (key === 'oneOf') {
      out.anyOf = normalizeToolSchema(raw);
      continue;
    }
    if (key === 'type' && Array.isArray(raw)) {
      const types = raw.filter((entry) => typeof entry === 'string');
      const nonNull = types.filter((entry) => entry !== 'null');
      if (types.length !== nonNull.length) out.nullable = true;
      out.type = nonNull[0] ?? 'string';
      continue;
    }
    out[key] = normalizeToolSchema(raw);
  }
  if (out.type === 'object' && out.properties === undefined) out.properties = {};
  return out;
}

// ---- 逻辑模型表（从 OMP 目录派生）----

/** 思考档位键，与 pi 的 `thinkingLevelMap` 同一值域；关闭思考算 `off` */
export type AntigravityEffort = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';

/** 由低到高。请求的档位在 `effortRouting` 里缺键时，沿这条阶梯往下降级 */
const EFFORT_LADDER: readonly AntigravityEffort[] = [
  'off',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
];

/**
 * 一条「展示用逻辑模型」。
 *
 * Antigravity 后端是**一个思考档一个模型 id**，所以展示用的逻辑 id ≠ 发给后端的
 * wire id：`requestModelId` 是没有档位路由时用的 wire id，`effortRouting` 是
 * 思考档 → wire id。这个映射**无法靠猜**（`gemini-3-flash` 的 wire id 是
 * `gemini-3.5-flash-extra-low`），必须来自数据。
 */
export interface AntigravityLogicalModel {
  readonly id: string;
  readonly name: string;
  readonly requestModelId: string;
  readonly effortRouting?: Readonly<Partial<Record<AntigravityEffort, string>>>;
  readonly reasoning: boolean;
  readonly input: readonly ('text' | 'image')[];
  readonly contextWindow: number;
  readonly maxTokens: number;
}

/**
 * ⛔ 本表与下面的 `ANTIGRAVITY_WIRE_MAX_OUTPUT_TOKENS` 都是**脚本生成的，不要手改**。
 *
 * 数据来自 OMP（github.com/can1357/oh-my-pi，MIT）的 `@oh-my-pi/pi-catalog`
 * （`src/models.json` 的 `google-antigravity` 段），那份 json 是 OMP 从真实
 * antigravity 客户端与后端离线生成的。要更新就跑
 *     node temp/gen-antigravity-models.mjs
 * 把输出整段替换进来，再跑 `npx biome check --write` 归一格式（脚本只保证内容，
 * 换行交给 biome）。`tab_*` / `chat_*`（补全用的 checkpoint 模型）在生成时已滤掉。
 *
 * 注意这里的 `id` 是逻辑 id，**不能直接当请求体的 `model` 发**——后端只认带档位
 * 后缀的 wire id，发裸逻辑 id 会拿到 404 `Requested entity was not found`。
 */
export const ANTIGRAVITY_LOGICAL_MODELS: readonly AntigravityLogicalModel[] = [
  {
    id: 'claude-opus-4-5',
    name: 'Claude Opus 4.5',
    requestModelId: 'claude-opus-4-5-thinking',
    effortRouting: {
      off: 'claude-opus-4-5',
      minimal: 'claude-opus-4-5-thinking',
      low: 'claude-opus-4-5-thinking',
      medium: 'claude-opus-4-5-thinking',
      high: 'claude-opus-4-5-thinking',
    },
    reasoning: true,
    input: ['text', 'image'],
    contextWindow: 200_000,
    maxTokens: 64_000,
  },
  {
    id: 'claude-opus-4-6',
    name: 'Claude Opus 4.6',
    requestModelId: 'claude-opus-4-6-thinking',
    reasoning: true,
    input: ['text', 'image'],
    contextWindow: 250_000,
    maxTokens: 64_000,
  },
  {
    id: 'claude-sonnet-4-5',
    name: 'Claude Sonnet 4.5',
    requestModelId: 'claude-sonnet-4-5',
    effortRouting: {
      off: 'claude-sonnet-4-5',
      minimal: 'claude-sonnet-4-5-thinking',
      low: 'claude-sonnet-4-5-thinking',
      medium: 'claude-sonnet-4-5-thinking',
      high: 'claude-sonnet-4-5-thinking',
    },
    reasoning: true,
    input: ['text', 'image'],
    contextWindow: 1_000_000,
    maxTokens: 64_000,
  },
  {
    id: 'claude-sonnet-4-6',
    name: 'Claude Sonnet 4.6',
    requestModelId: 'claude-sonnet-4-6',
    reasoning: true,
    input: ['text', 'image'],
    contextWindow: 250_000,
    maxTokens: 64_000,
  },
  {
    id: 'gemini-2.5-flash',
    name: 'Gemini 2.5 Flash',
    requestModelId: 'gemini-2.5-flash',
    effortRouting: {
      off: 'gemini-2.5-flash',
      minimal: 'gemini-2.5-flash-thinking',
      low: 'gemini-2.5-flash-thinking',
      medium: 'gemini-2.5-flash-thinking',
      high: 'gemini-2.5-flash-thinking',
    },
    reasoning: true,
    input: ['text', 'image'],
    contextWindow: 1_048_576,
    maxTokens: 65_535,
  },
  {
    id: 'gemini-2.5-flash-lite',
    name: 'Gemini 2.5 Flash Lite',
    requestModelId: 'gemini-2.5-flash-lite',
    reasoning: true,
    input: ['text', 'image'],
    contextWindow: 1_048_576,
    maxTokens: 65_535,
  },
  {
    id: 'gemini-2.5-pro',
    name: 'Gemini 2.5 Pro',
    requestModelId: 'gemini-2.5-pro',
    reasoning: true,
    input: ['text', 'image'],
    contextWindow: 1_048_576,
    maxTokens: 65_536,
  },
  {
    id: 'gemini-3-flash',
    name: 'Gemini 3 Flash',
    requestModelId: 'gemini-3.5-flash-extra-low',
    effortRouting: {
      off: 'gemini-3.5-flash-extra-low',
      minimal: 'gemini-3.5-flash-extra-low',
      low: 'gemini-3.5-flash-extra-low',
      medium: 'gemini-3.5-flash-low',
      high: 'gemini-3-flash-agent',
    },
    reasoning: true,
    input: ['text', 'image'],
    contextWindow: 1_048_576,
    maxTokens: 65_536,
  },
  {
    id: 'gemini-3-pro',
    name: 'Gemini 3 Pro',
    requestModelId: 'gemini-3-pro-low',
    effortRouting: { off: 'gemini-3-pro-low', low: 'gemini-3-pro-low', high: 'gemini-3-pro-high' },
    reasoning: true,
    input: ['text', 'image'],
    contextWindow: 1_048_576,
    maxTokens: 65_535,
  },
  {
    id: 'gemini-3.1-flash-image',
    name: 'Gemini 3.1 Flash Image',
    requestModelId: 'gemini-3.1-flash-image',
    reasoning: false,
    input: ['text'],
    contextWindow: 200_000,
    maxTokens: 64_000,
  },
  {
    id: 'gemini-3.1-flash-lite',
    name: 'Gemini 3.1 Flash Lite',
    requestModelId: 'gemini-3.1-flash-lite',
    reasoning: true,
    input: ['text', 'image'],
    contextWindow: 1_048_576,
    maxTokens: 65_535,
  },
  {
    id: 'gemini-3.1-pro',
    name: 'Gemini 3.1 Pro Preview',
    requestModelId: 'gemini-3.1-pro-low',
    effortRouting: {
      off: 'gemini-3.1-pro-low',
      low: 'gemini-3.1-pro-low',
      high: 'gemini-pro-agent',
    },
    reasoning: true,
    input: ['text', 'image'],
    contextWindow: 1_048_576,
    maxTokens: 65_535,
  },
  {
    id: 'gemini-3.5-flash',
    name: 'Gemini 3.5 Flash',
    requestModelId: 'gemini-3.5-flash-extra-low',
    effortRouting: {
      off: 'gemini-3.5-flash-extra-low',
      minimal: 'gemini-3.5-flash-extra-low',
      low: 'gemini-3.5-flash-extra-low',
      medium: 'gemini-3.5-flash-low',
      high: 'gemini-3-flash-agent',
    },
    reasoning: true,
    input: ['text', 'image'],
    contextWindow: 1_048_576,
    maxTokens: 65_536,
  },
  {
    id: 'gemini-3.6-flash',
    name: 'Gemini 3.6 Flash',
    requestModelId: 'gemini-3.6-flash-low',
    effortRouting: {
      minimal: 'gemini-3.6-flash-low',
      low: 'gemini-3.6-flash-low',
      medium: 'gemini-3.6-flash-medium',
      high: 'gemini-3.6-flash-high',
    },
    reasoning: true,
    input: ['text', 'image'],
    contextWindow: 1_048_576,
    maxTokens: 65_536,
  },
  {
    id: 'gemini-3.7-flash',
    name: 'Gemini 3.7 Flash',
    requestModelId: 'gemini-3.7-flash-low',
    effortRouting: {
      minimal: 'gemini-3.7-flash-low',
      low: 'gemini-3.7-flash-low',
      medium: 'gemini-3.7-flash-medium',
      high: 'gemini-3.7-flash-high',
    },
    reasoning: true,
    input: ['text', 'image'],
    contextWindow: 1_048_576,
    maxTokens: 65_536,
  },
  {
    id: 'gemini-3.7-flash-tiered',
    name: 'gemini-3.7-flash-tiered',
    requestModelId: 'gemini-3.7-flash-tiered',
    reasoning: true,
    input: ['text', 'image'],
    contextWindow: 1_048_576,
    maxTokens: 65_536,
  },
  {
    id: 'gpt-oss-120b',
    name: 'GPT OSS 120B',
    requestModelId: 'gpt-oss-120b-medium',
    reasoning: true,
    input: ['text'],
    contextWindow: 131_072,
    maxTokens: 32_768,
  },
];

/**
 * 每个 wire id 的固定 `generationConfig.maxOutputTokens`（真实客户端抓包值，与思考
 * 预算无关）。生成自 pi-catalog 的
 * `src/wire/gemini-headers.ts::ANTIGRAVITY_MODEL_WIRE_PROFILES`。
 *
 * ⚠️ OMP 只抓到了一部分 wire id 的 profile（`gemini-3.1-flash-lite` 这种只做补全的
 * 一律缺）。缺 profile 时我们沿用逻辑模型自己的 `maxTokens` + Claude 的 64000 上限，
 * 与 OMP 的「有 profile 才重赋」（`google-gemini-cli.ts:1383-1386`）一致。
 */
export const ANTIGRAVITY_WIRE_MAX_OUTPUT_TOKENS: Readonly<Record<string, number>> = {
  'gemini-3.5-flash-extra-low': 65_536,
  'gemini-3.5-flash-low': 65_536,
  'gemini-3-flash-agent': 65_536,
  'gemini-3.1-pro-low': 65_535,
  'gemini-pro-agent': 65_535,
  'claude-sonnet-4-6': 64_000,
  'claude-opus-4-6-thinking': 64_000,
};

const LOGICAL_BY_ID: Readonly<Record<string, AntigravityLogicalModel | undefined>> =
  Object.fromEntries(ANTIGRAVITY_LOGICAL_MODELS.map((model) => [model.id, model]));

/** 某条逻辑模型在所有档位下可能发出的 wire id 全集 */
export function antigravityWireIds(model: AntigravityLogicalModel): string[] {
  const ids = new Set<string>([model.requestModelId]);
  if (model.effortRouting) {
    for (const wire of Object.values(model.effortRouting)) ids.add(wire);
  }
  return [...ids];
}

/**
 * 逻辑 id + 思考档 → 真正发给后端的 wire id。
 *
 * `effortRouting` 里没有请求档位时逐级降档（`max`→`xhigh`→`high`→…），一路没命中
 * 就回落 `requestModelId`。逻辑表里查不到的 id（运行时从后端发现的裸 wire id）原样返回。
 */
export function resolveAntigravityWireModelId(modelId: string, effort?: string | null): string {
  const logical = LOGICAL_BY_ID[modelId];
  if (!logical) return modelId;
  const routing = logical.effortRouting;
  if (routing) {
    // 认不出的档位（含 undefined）当 off
    const start = Math.max(
      0,
      EFFORT_LADDER.findIndex((level) => level === effort)
    );
    for (let index = start; index >= 0; index -= 1) {
      const wire = routing[EFFORT_LADDER[index]];
      if (wire) return wire;
    }
  }
  return logical.requestModelId;
}

// ---- 请求构建（pi Context → Cloud Code Assist 信封）----

interface GeminiPart {
  text?: string;
  thought?: boolean;
  thoughtSignature?: string;
  inlineData?: { mimeType: string; data: string };
  functionCall?: { name: string; args: Record<string, unknown>; id?: string };
  functionResponse?: {
    name: string;
    response: Record<string, unknown>;
    parts?: GeminiPart[];
    id?: string;
  };
}

interface GeminiContent {
  role: 'user' | 'model';
  parts: GeminiPart[];
}

const NON_VISION_PLACEHOLDER = '(图片已省略：当前模型不支持图片输入)';
/** Gemini 3 的 toolCall 没有真实 thoughtSignature 时的占位值，照搬 OMP */
const SKIP_THOUGHT_SIGNATURE = 'skip_thought_signature_validator';
const BASE64_SIGNATURE = /^[A-Za-z0-9+/]+={0,2}$/;

function isValidThoughtSignature(signature: string | undefined): boolean {
  if (!signature || signature.length % 4 !== 0) return false;
  return BASE64_SIGNATURE.test(signature);
}

function isGemini3Plus(modelId: string): boolean {
  const match = /^gemini-(\d+)/.exec(modelId.toLowerCase());
  return match ? Number.parseInt(match[1], 10) >= 3 : true;
}

export function convertMessages(model: PiModel, context: PiContext): GeminiContent[] {
  const contents: GeminiContent[] = [];
  const supportsImages = model.input.includes('image');
  const isClaude = model.id.startsWith('claude-');
  const emittedToolNames = new Map<string, string>();

  for (const message of context.messages) {
    if (message.role === 'user') {
      const parts: GeminiPart[] = [];
      if (typeof message.content === 'string') {
        if (message.content.trim()) parts.push({ text: message.content.toWellFormed() });
      } else {
        let omittedImages = false;
        for (const item of message.content) {
          if (item.type === 'text') {
            if (item.text.trim()) parts.push({ text: item.text.toWellFormed() });
          } else if (supportsImages) {
            parts.push({ inlineData: { mimeType: item.mimeType, data: item.data } });
          } else {
            omittedImages = true;
          }
        }
        if (omittedImages) parts.push({ text: NON_VISION_PLACEHOLDER });
      }
      if (parts.length > 0) contents.push({ role: 'user', parts });
      continue;
    }

    if (message.role === 'assistant') {
      // 只有同一 provider + 同一模型产出的 thoughtSignature 才能回传，否则后端拒
      const sameModel = message.provider === model.provider && message.model === model.id;
      const parts: GeminiPart[] = [];
      for (const block of message.content) {
        appendAssistantPart(parts, block, {
          sameModel,
          isClaude,
          modelId: model.id,
          emittedToolNames,
        });
      }
      if (parts.length > 0) contents.push({ role: 'model', parts });
      continue;
    }

    const textResult = message.content
      .filter((item): item is PiTextContent => item.type === 'text')
      .map((item) => item.text)
      .join('\n');
    const images = supportsImages ? message.content.filter((item) => item.type === 'image') : [];
    const omittedImages = !supportsImages && message.content.some((item) => item.type === 'image');
    const payload = omittedImages
      ? [textResult, NON_VISION_PLACEHOLDER].filter(Boolean).join('\n')
      : textResult || (images.length > 0 ? '(见附带图片)' : '');
    const part: GeminiPart = {
      functionResponse: {
        name: emittedToolNames.get(message.toolCallId) ?? message.toolName,
        response: message.isError ? { error: payload } : { output: payload },
        ...(images.length > 0
          ? {
              parts: images.map((item) => ({
                inlineData: { mimeType: item.mimeType, data: item.data },
              })),
            }
          : {}),
        id: message.toolCallId,
      },
    };
    // Cloud Code Assist 要求同一批 functionResponse 必须挤在一个 user turn 里，
    // 否则报 "number of function response parts is not equal to number of function call parts"
    const last = contents[contents.length - 1];
    if (last?.role === 'user' && last.parts.some((entry) => entry.functionResponse)) {
      last.parts.push(part);
    } else {
      contents.push({ role: 'user', parts: [part] });
    }
  }

  return contents;
}

function appendAssistantPart(
  parts: GeminiPart[],
  block: PiContentBlock,
  ctx: {
    sameModel: boolean;
    isClaude: boolean;
    modelId: string;
    emittedToolNames: Map<string, string>;
  }
): void {
  const keepSignature = (signature: string | undefined): string | undefined =>
    ctx.sameModel && isValidThoughtSignature(signature) ? signature : undefined;

  if (block.type === 'text') {
    // 空 text block 会让 Antigravity 上的 Claude 直接 400
    if (!block.text.trim()) return;
    const signature = keepSignature(block.textSignature);
    parts.push({
      text: block.text.toWellFormed(),
      ...(signature ? { thoughtSignature: signature } : {}),
    });
    return;
  }

  if (block.type === 'thinking') {
    if (!block.thinking.trim()) return;
    const signature = keepSignature(block.thinkingSignature);
    if (signature) {
      parts.push({
        thought: true,
        text: block.thinking.toWellFormed(),
        thoughtSignature: signature,
      });
      return;
    }
    // Claude on Antigravity 拒收无签名 thinking，只能整块丢；Gemini 侧降级成普通文本
    if (ctx.isClaude) return;
    parts.push({ text: `<thinking>\n${block.thinking.toWellFormed()}\n</thinking>` });
    return;
  }

  ctx.emittedToolNames.set(block.id, block.name);
  const signature =
    keepSignature(block.thoughtSignature) ??
    (isGemini3Plus(ctx.modelId) ? SKIP_THOUGHT_SIGNATURE : undefined);
  parts.push({
    functionCall: { name: block.name, args: block.arguments ?? {}, id: block.id },
    ...(signature ? { thoughtSignature: signature } : {}),
  });
}

export function convertTools(
  tools: PiTool[] | undefined
): { functionDeclarations: unknown[] }[] | undefined {
  if (!tools || tools.length === 0) return undefined;
  // Antigravity 统一走 legacy `parameters` 字段，后端再翻译成各家的 input_schema
  return [
    {
      functionDeclarations: tools.map((tool) => ({
        name: tool.name,
        description: tool.description || '',
        parameters: normalizeToolSchema(tool.parameters),
      })),
    },
  ];
}

interface RequestEnvelope {
  sessionId: string;
  requestId: string;
  labels: Record<string, string>;
}

interface SessionState {
  agentId: string;
  trajectoryId: string;
  sessionId: string;
  stepIndex: number;
}

/**
 * 真实客户端的 requestId 形如 `agent/<agentId>/<ts>/<trajectoryId>/<step>`，
 * 同一会话内 agentId/trajectoryId/sessionId 必须稳定、step 递增，
 * 所以按 pi 的 sessionId 缓存一份状态。容量设上限并按最近使用驱逐，避免长跑进程
 * 无界增长时把仍活跃的会话误当成新会话。
 */
const SESSION_STATE_LIMIT = 64;
const sessionStates = new Map<string, SessionState>();

function createSessionState(): SessionState {
  return {
    agentId: randomUUID(),
    trajectoryId: randomUUID(),
    // 真实客户端用的是负号十进制 int63
    sessionId: `-${(randomBytes(8).readBigUInt64BE() % 9_000_000_000_000_000_000n).toString()}`,
    stepIndex: 1,
  };
}

function nextEnvelope(sessionKey: string | undefined, isClaude: boolean): RequestEnvelope {
  let state = sessionKey ? sessionStates.get(sessionKey) : undefined;
  if (state && sessionKey) {
    // Map 的迭代顺序就是 LRU 顺序，命中后挪到末尾
    sessionStates.delete(sessionKey);
    sessionStates.set(sessionKey, state);
  } else {
    state = createSessionState();
    if (sessionKey) {
      if (sessionStates.size >= SESSION_STATE_LIMIT) {
        const leastRecentlyUsed = sessionStates.keys().next().value;
        if (leastRecentlyUsed !== undefined) sessionStates.delete(leastRecentlyUsed);
      }
      sessionStates.set(sessionKey, state);
    }
  }
  state.stepIndex += 1;
  return {
    sessionId: state.sessionId,
    requestId: `agent/${state.agentId}/${Date.now()}/${state.trajectoryId}/${state.stepIndex}`,
    labels: {
      last_step_index: String(state.stepIndex - 1),
      trajectory_id: state.trajectoryId,
      used_claude: String(isClaude),
      used_claude_conservative: String(isClaude),
    },
  };
}

const THINKING_LEVELS: Record<string, string> = {
  minimal: 'MINIMAL',
  low: 'LOW',
  medium: 'MEDIUM',
  high: 'HIGH',
  xhigh: 'HIGH',
  max: 'HIGH',
};

export interface CloudCodeAssistRequest {
  project: string;
  model: string;
  requestId: string;
  requestType: string;
  userAgent: string;
  request: Record<string, unknown>;
}

export function buildRequest(
  model: PiModel,
  context: PiContext,
  projectId: string,
  options: PiStreamOptions | undefined
): CloudCodeAssistRequest {
  const isClaude = model.id.startsWith('claude-');
  const envelope = nextEnvelope(options?.sessionId, isClaude);
  // 逻辑 id ≠ wire id：后端一个思考档一个模型 id，必须按当前档位解析后再发
  const wireModelId = resolveAntigravityWireModelId(model.id, options?.reasoning);

  const generationConfig: Record<string, unknown> = {};
  if (options?.temperature !== undefined) generationConfig.temperature = options.temperature;
  // 输出上限按**解析后的 wire 模型**取（真实客户端每个 wire id 有固定上限，
  // 与思考预算无关）；没有抓包 profile 时退到逻辑模型的 maxTokens，
  // 并保留 Claude 在 daily-cloudcode-pa 上 maxOutputTokens > 64000 会 400 的钳制
  const cap =
    ANTIGRAVITY_WIRE_MAX_OUTPUT_TOKENS[wireModelId] ??
    (isClaude ? Math.min(64_000, model.maxTokens) : model.maxTokens);
  generationConfig.maxOutputTokens = Math.min(options?.maxTokens ?? cap, cap);

  const level = options?.reasoning;
  if (model.reasoning && level) {
    const mapped = model.thinkingLevelMap?.[level];
    if (mapped !== null) {
      const thinkingConfig: Record<string, unknown> = { includeThoughts: true };
      if (isGemini3Plus(model.id)) {
        thinkingConfig.thinkingLevel = mapped ?? THINKING_LEVELS[level] ?? 'MEDIUM';
      } else {
        const budget = options?.thinkingBudgets?.[level as 'minimal' | 'low' | 'medium' | 'high'];
        if (budget !== undefined) thinkingConfig.thinkingBudget = budget;
      }
      generationConfig.thinkingConfig = thinkingConfig;
    }
  }

  const request: Record<string, unknown> = {
    contents: convertMessages(model, context),
    sessionId: envelope.sessionId,
    labels: envelope.labels,
    generationConfig,
  };
  if (context.systemPrompt?.trim()) {
    // 真实客户端把 systemInstruction 标成 role: user
    request.systemInstruction = { role: 'user', parts: [{ text: context.systemPrompt }] };
  }
  const tools = convertTools(context.tools);
  if (tools) request.tools = tools;
  if (options?.toolChoice === 'none') {
    request.toolConfig = { functionCallingConfig: { mode: 'NONE' } };
  } else {
    // Antigravity 的默认工具模式是 VALIDATED（Gemini 与 Claude 均已实测）
    request.toolConfig = { functionCallingConfig: { mode: 'VALIDATED' } };
  }

  return {
    project: projectId,
    model: wireModelId,
    requestId: envelope.requestId,
    requestType: 'agent',
    userAgent: 'antigravity',
    request,
  };
}

// ---- SSE ----

export interface CloudCodeAssistChunk {
  response?: {
    candidates?: {
      content?: { parts?: GeminiPart[] };
      finishReason?: string;
    }[];
    usageMetadata?: {
      promptTokenCount?: number;
      candidatesTokenCount?: number;
      thoughtsTokenCount?: number;
      totalTokenCount?: number;
      cachedContentTokenCount?: number;
    };
    promptFeedback?: { blockReason?: string; blockReasonMessage?: string };
  };
  error?: { code?: number; message?: string; status?: string };
}

/**
 * 把字节块流切成 SSE 事件并 JSON.parse。
 * 分块边界可能落在 JSON 中间、也可能落在 `\n\n` 中间，所以按缓冲区累积；
 * 解不出来的事件直接跳过（后端偶发混入非 JSON 的 keep-alive 注释行）。
 */
export async function* iterateSseJson(
  chunks: AsyncIterable<Uint8Array> | Iterable<Uint8Array>
): AsyncGenerator<CloudCodeAssistChunk> {
  const decoder = new TextDecoder();
  let buffer = '';

  const flush = function* (block: string): Generator<CloudCodeAssistChunk> {
    const data = block
      .split(/\r?\n/)
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trimStart())
      .join('\n');
    if (!data || data === '[DONE]') return;
    try {
      yield JSON.parse(data) as CloudCodeAssistChunk;
    } catch {
      // 非 JSON 的事件体忽略
    }
  };

  for await (const chunk of chunks) {
    buffer += decoder.decode(chunk, { stream: true });
    let boundary = buffer.search(/\r?\n\r?\n/);
    while (boundary !== -1) {
      const block = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary).replace(/^\r?\n\r?\n/, '');
      yield* flush(block);
      boundary = buffer.search(/\r?\n\r?\n/);
    }
  }
  buffer += decoder.decode();
  if (buffer.trim()) yield* flush(buffer);
}

async function* readResponseChunks(body: ReadableStream<Uint8Array>): AsyncGenerator<Uint8Array> {
  const reader = body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) return;
      if (value) yield value;
    }
  } finally {
    reader.releaseLock();
  }
}

// ---- streamSimple ----

function mapStopReason(reason: string): PiStopReason {
  if (reason === 'STOP') return 'stop';
  if (reason === 'MAX_TOKENS') return 'length';
  return 'error';
}

function mergeHeaders(
  base: Record<string, string>,
  overrides: Record<string, string | null> | undefined
): Record<string, string> {
  if (!overrides) return base;
  const merged = { ...base };
  for (const [key, value] of Object.entries(overrides)) {
    if (value === null) delete merged[key];
    else merged[key] = value;
  }
  return merged;
}

const TRANSIENT_STATUS = new Set([408, 409, 425, 429, 500, 502, 503, 504]);

function streamAntigravity(
  model: PiModel,
  context: PiContext,
  options?: PiStreamOptions
): PiEventStream {
  const stream = createEventStream();
  const output: PiAssistantMessage = {
    role: 'assistant',
    content: [],
    api: ANTIGRAVITY_API_ID,
    provider: model.provider,
    model: model.id,
    usage: emptyUsage(),
    stopReason: 'stop',
    timestamp: Date.now(),
  };

  void (async () => {
    try {
      if (!options?.apiKey) throw new Error('Antigravity 需要 OAuth 登录后才能调用');
      const credentials = parseAntigravityApiKey(options.apiKey);
      if (isAccessTokenExpired(credentials.expires)) {
        throw new Error('Antigravity access token 已过期，请重试（下一次请求会自动刷新）');
      }
      await ensureAntigravityVersion(options.fetch ?? fetch, options.signal);

      let body: unknown = buildRequest(model, context, credentials.projectId, options);
      const replaced = await options.onPayload?.(body, model);
      if (replaced !== undefined) body = replaced;
      const payload = JSON.stringify(body);

      const headers = mergeHeaders(
        {
          Authorization: `Bearer ${credentials.access}`,
          'Content-Type': 'application/json',
          Accept: 'text/event-stream',
          'User-Agent': antigravityUserAgent(),
          ...(model.id.startsWith('claude-') && model.reasoning
            ? { 'anthropic-beta': 'interleaved-thinking-2025-05-14' }
            : {}),
        },
        options.headers
      );

      const doFetch = options.fetch ?? fetch;
      const endpoints =
        model.baseUrl && !ENDPOINTS.includes(model.baseUrl) ? [model.baseUrl] : ENDPOINTS;

      let lastError: Error | undefined;
      for (let i = 0; i < endpoints.length; i++) {
        const isLast = i === endpoints.length - 1;
        let response: Response;
        try {
          response = await doFetch(`${endpoints[i]}/v1internal:streamGenerateContent?alt=sse`, {
            method: 'POST',
            headers,
            body: payload,
            signal: options.signal,
          });
        } catch (error) {
          lastError = error instanceof Error ? error : new Error(String(error));
          if (isLast) throw lastError;
          continue;
        }
        await options.onResponse?.(
          { status: response.status, headers: Object.fromEntries(response.headers) },
          model
        );

        if (!response.ok) {
          const detail = sanitizeUpstreamBody(await response.text().catch(() => ''));
          const error = new Error(
            `Cloud Code Assist 返回 ${response.status}${detail ? `: ${detail}` : ''}`
          );
          if (!isLast && TRANSIENT_STATUS.has(response.status)) {
            lastError = error;
            continue;
          }
          throw error;
        }
        if (!response.body) {
          const error = new Error('Cloud Code Assist 响应没有 body');
          if (!isLast) {
            lastError = error;
            continue;
          }
          throw error;
        }

        await consumeStream(response.body, model, stream, output);
        lastError = undefined;
        break;
      }
      if (lastError) throw lastError;

      if (output.stopReason === 'error') {
        throw new Error(output.errorMessage ?? 'Cloud Code Assist 生成失败');
      }
      stream.push({
        type: 'done',
        reason: output.stopReason as 'stop' | 'length' | 'toolUse',
        message: output,
      });
      stream.end();
    } catch (error) {
      output.stopReason = options?.signal?.aborted ? 'aborted' : 'error';
      output.errorMessage = error instanceof Error ? error.message : String(error);
      stream.push({
        type: 'error',
        reason: output.stopReason as 'aborted' | 'error',
        error: output,
      });
      stream.end();
    }
  })();

  return stream;
}

/** 消费一条 SSE 响应，把 Gemini part 翻成 pi 的事件序列 */
async function consumeStream(
  body: ReadableStream<Uint8Array>,
  model: PiModel,
  stream: PiEventStream,
  output: PiAssistantMessage
): Promise<void> {
  let started = false;
  let current: PiTextContent | PiThinkingContent | null = null;
  let sawFinishReason = false;
  const blockIndex = (): number => output.content.length - 1;

  const ensureStarted = (): void => {
    if (started) return;
    started = true;
    stream.push({ type: 'start', partial: output });
  };
  const endBlock = (): void => {
    if (!current) return;
    if (current.type === 'text') {
      stream.push({
        type: 'text_end',
        contentIndex: blockIndex(),
        content: current.text,
        partial: output,
      });
    } else {
      stream.push({
        type: 'thinking_end',
        contentIndex: blockIndex(),
        content: current.thinking,
        partial: output,
      });
    }
    current = null;
  };
  const openBlock = (thinking: boolean): PiTextContent | PiThinkingContent => {
    if (current && (current.type === 'thinking') === thinking) return current;
    endBlock();
    const block: PiTextContent | PiThinkingContent = thinking
      ? { type: 'thinking', thinking: '' }
      : { type: 'text', text: '' };
    output.content.push(block);
    ensureStarted();
    stream.push({
      type: thinking ? 'thinking_start' : 'text_start',
      contentIndex: blockIndex(),
      partial: output,
    });
    current = block;
    return block;
  };

  for await (const chunk of iterateSseJson(readResponseChunks(body))) {
    if (chunk.error) {
      const detail = sanitizeUpstreamBody(chunk.error.message || chunk.error.status || '未知错误');
      throw new Error(`Cloud Code Assist 流内错误：${detail}`);
    }
    const data = chunk.response;
    if (!data) continue;
    const candidate = data.candidates?.[0];
    if (!candidate && data.promptFeedback?.blockReason) {
      const detail = data.promptFeedback.blockReasonMessage;
      throw new Error(
        `请求被 Google 拦截（${data.promptFeedback.blockReason}）${
          detail ? `：${sanitizeUpstreamBody(detail)}` : ''
        }`
      );
    }

    for (const part of candidate?.content?.parts ?? []) {
      if (part.text) {
        if (part.thought === true) {
          const block = openBlock(true) as PiThinkingContent;
          block.thinking += part.text;
          if (part.thoughtSignature) block.thinkingSignature = part.thoughtSignature;
          stream.push({
            type: 'thinking_delta',
            contentIndex: blockIndex(),
            delta: part.text,
            partial: output,
          });
        } else {
          const block = openBlock(false) as PiTextContent;
          block.text += part.text;
          if (part.thoughtSignature) block.textSignature = part.thoughtSignature;
          stream.push({
            type: 'text_delta',
            contentIndex: blockIndex(),
            delta: part.text,
            partial: output,
          });
        }
      }
      if (!part.functionCall) continue;

      endBlock();
      const name = part.functionCall.name || 'tool';
      const provided = part.functionCall.id;
      const duplicate =
        !provided ||
        output.content.some((entry) => entry.type === 'toolCall' && entry.id === provided);
      const toolCall: PiToolCall = {
        type: 'toolCall',
        id: duplicate ? `${name}_${Date.now()}_${output.content.length}` : provided,
        name,
        arguments: part.functionCall.args ?? {},
        ...(part.thoughtSignature ? { thoughtSignature: part.thoughtSignature } : {}),
      };
      output.content.push(toolCall);
      ensureStarted();
      stream.push({ type: 'toolcall_start', contentIndex: blockIndex(), partial: output });
      stream.push({
        type: 'toolcall_delta',
        contentIndex: blockIndex(),
        delta: JSON.stringify(toolCall.arguments),
        partial: output,
      });
      stream.push({ type: 'toolcall_end', contentIndex: blockIndex(), toolCall, partial: output });
    }

    if (candidate?.finishReason) {
      sawFinishReason = true;
      const mapped = mapStopReason(candidate.finishReason);
      const hasToolCall = output.content.some((entry) => entry.type === 'toolCall');
      if ((mapped === 'stop' || mapped === 'length') && hasToolCall) {
        output.stopReason = 'toolUse';
      } else {
        output.stopReason = mapped;
        if (mapped === 'error') {
          output.errorMessage = `生成中止，finishReason=${candidate.finishReason}`;
        }
      }
    }

    if (data.usageMetadata) {
      const prompt = data.usageMetadata.promptTokenCount ?? 0;
      const cacheRead = data.usageMetadata.cachedContentTokenCount ?? 0;
      const thinking = data.usageMetadata.thoughtsTokenCount ?? 0;
      output.usage = {
        ...emptyUsage(),
        // promptTokenCount 含 cachedContentTokenCount，减掉才是新鲜输入
        input: prompt - cacheRead,
        output: (data.usageMetadata.candidatesTokenCount ?? 0) + thinking,
        cacheRead,
        reasoning: thinking,
        totalTokens: data.usageMetadata.totalTokenCount ?? 0,
      };
    }
  }

  endBlock();
  ensureStarted();

  if (!sawFinishReason) {
    throw new Error('Cloud Code Assist 流没有 finishReason 就结束了（连接被掐断或响应被截断）');
  }
  const meaningful = output.content.some(
    (entry) => entry.type === 'toolCall' || (entry.type === 'text' && entry.text.trim().length > 0)
  );
  if (!meaningful && output.stopReason !== 'error') {
    throw new Error(`${model.id} 返回了空响应（没有正文也没有工具调用）`);
  }
}

// ---- 模型发现 ----

const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
const DEFAULT_CONTEXT_WINDOW = 200_000;
const DEFAULT_MAX_TOKENS = 64_000;
/**
 * 后端会返回内部实验模型和补全用的 checkpoint 模型，都不该出现在选择器里。
 * 用前缀匹配而不是逐个列 id：`tab_*`（行内补全）/ `chat_*`（快捷聊天）都是
 * 带数字后缀的一族，后端上新一个就会漏。
 */
const MODEL_ID_DENYLIST = /^(?:tab|chat)_/;

function modelSpec(
  id: string,
  name: string,
  reasoning: boolean,
  contextWindow: number,
  maxTokens: number,
  image = true
): PiModelSpec {
  return {
    id,
    name,
    reasoning,
    input: image ? ['text', 'image'] : ['text'],
    cost: ZERO_COST,
    contextWindow,
    maxTokens,
  };
}

function sortModelSpecs(specs: PiModelSpec[]): PiModelSpec[] {
  specs.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  return specs;
}

/**
 * 网络不可用时的兜底清单 —— 逻辑表全量。
 *
 * ⚠️ 这里的 id 是**展示用逻辑 id**，发请求前必须过 `resolveAntigravityWireModelId`；
 * 早期版本把逻辑 id 直接当请求体的 `model` 发，后端一律回
 * `404 Requested entity was not found`。
 */
export const ANTIGRAVITY_FALLBACK_MODELS: PiModelSpec[] = ANTIGRAVITY_LOGICAL_MODELS.map(
  (logical) =>
    modelSpec(
      logical.id,
      logical.name,
      logical.reasoning,
      logical.contextWindow,
      logical.maxTokens,
      logical.input.includes('image')
    )
);

/**
 * 把 `fetchAvailableModels` 发现的**原始 wire id** 与逻辑表合并：
 * - wire id 能归到某条逻辑模型 → 不单独暴露，只用来确认该逻辑模型在本账号可用
 * - 归不到的 → 原样暴露（id 即 wire id），后端上新模型不至于用不了
 * - 逻辑条目的 wire id 一个都没被后端返回 → 本账号 tier 拿不到，不暴露
 */
export function mergeAntigravityModels(discovered: PiModelSpec[]): PiModelSpec[] {
  const available = new Set(discovered.map((spec) => spec.id));
  const claimed = new Set<string>();
  const merged: PiModelSpec[] = [];
  for (const logical of ANTIGRAVITY_LOGICAL_MODELS) {
    const wireIds = antigravityWireIds(logical);
    for (const wire of wireIds) claimed.add(wire);
    if (!wireIds.some((wire) => available.has(wire))) continue;
    merged.push(
      modelSpec(
        logical.id,
        logical.name,
        logical.reasoning,
        logical.contextWindow,
        logical.maxTokens,
        logical.input.includes('image')
      )
    );
  }
  for (const spec of discovered) {
    if (claimed.has(spec.id)) continue;
    // `gemini-3-flash` 这类 id 既是逻辑 id 又是后端的独立 wire id。原样暴露会与逻辑条目
    // 撞 id，而且 resolve 时照样走逻辑映射，所以这个 id 一律交给逻辑表处理。
    if (LOGICAL_BY_ID[spec.id]) continue;
    merged.push(spec);
  }
  return sortModelSpecs(merged);
}

function positiveNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;
}

/**
 * 解析 `fetchAvailableModels` 的响应。脏输入（顶层非对象、models 非对象、
 * 条目为 null / 缺字段、类型不符）一律跳过而不抛，返回空数组由调用方兜底。
 */
export function parseAvailableModels(payload: unknown): PiModelSpec[] {
  if (!payload || typeof payload !== 'object') return [];
  const models = (payload as Record<string, unknown>).models;
  if (!models || typeof models !== 'object' || Array.isArray(models)) return [];

  const specs: PiModelSpec[] = [];
  for (const [id, raw] of Object.entries(models as Record<string, unknown>)) {
    if (!raw || typeof raw !== 'object') continue;
    if (MODEL_ID_DENYLIST.test(id)) continue;
    const entry = raw as Record<string, unknown>;
    if (entry.isInternal === true) continue;
    specs.push(
      modelSpec(
        id,
        optionalString(entry.displayName) ?? id,
        entry.supportsThinking === true,
        positiveNumber(entry.maxTokens, DEFAULT_CONTEXT_WINDOW),
        positiveNumber(entry.maxOutputTokens, DEFAULT_MAX_TOKENS),
        entry.supportsImages === true
      )
    );
  }
  return sortModelSpecs(specs);
}

async function fetchAvailableModels(
  accessToken: string,
  signal: AbortSignal | undefined
): Promise<unknown | undefined> {
  for (const endpoint of ENDPOINTS) {
    try {
      const response = await fetchWithTimeout(
        `${endpoint}/v1internal:fetchAvailableModels`,
        { method: 'POST', headers: controlPlaneHeaders(accessToken), body: '{}' },
        signal
      );
      if (!response.ok) continue;
      return await response.json();
    } catch {
      // 换下一个端点
    }
  }
  return undefined;
}

async function refreshModels(context: PiRefreshModelsContext): Promise<PiModelSpec[]> {
  const credential = context.credential;
  const access =
    credential && credential.type === 'oauth' ? optionalString(credential.access) : undefined;
  if (!context.allowNetwork || !access) return ANTIGRAVITY_FALLBACK_MODELS;

  await ensureAntigravityVersion(fetch, context.signal);
  const payload = await fetchAvailableModels(access, context.signal);
  const discovered = parseAvailableModels(payload);
  if (discovered.length === 0) return ANTIGRAVITY_FALLBACK_MODELS;
  const merged = mergeAntigravityModels(discovered);
  return merged.length > 0 ? merged : ANTIGRAVITY_FALLBACK_MODELS;
}

// ---- 额度 ----

const DAY_MS = 86_400_000;

/**
 * 直接复用 IPC 契约类型，别在这里另立一份同形结构 —— probeAccount 把
 * fetchAntigravityUsage 的结果原样塞进 OauthAccountUsage.windows，
 * 两边一旦漂移编译期抓不到（字段同名同类型），只会在界面上悄悄少一列。
 */
export type AntigravityUsageWindow = OauthUsageWindow;

interface QuotaEntry {
  remainingFraction?: number;
  resetTime?: string;
  windowLabel?: string;
  modelProvider?: string;
  apiProvider?: string;
}

function quotaLabel(entry: QuotaEntry, resetsAt: number | undefined, nowMs: number): string {
  const backend = entry.modelProvider ?? entry.apiProvider ?? '';
  const vendor = backend.includes('ANTHROPIC')
    ? 'Anthropic'
    : backend.includes('GOOGLE') || backend.includes('GEMINI')
      ? 'Google'
      : backend.includes('OPENAI')
        ? 'OpenAI'
        : '';
  // 后端很少给 windowLabel，按 resetTime 距今是否超过一天区分 daily / weekly
  const window =
    entry.windowLabel ?? (resetsAt !== undefined && resetsAt - nowMs > DAY_MS ? 'Weekly' : 'Daily');
  return vendor ? `${vendor} ${window}` : window;
}

function collectQuotas(entry: Record<string, unknown>): QuotaEntry[] {
  const out: QuotaEntry[] = [];
  const shared = {
    modelProvider: optionalString(entry.modelProvider),
    apiProvider: optionalString(entry.apiProvider),
  };
  const push = (value: unknown, label?: string): void => {
    const items = Array.isArray(value) ? value : [value];
    for (const item of items) {
      if (!item || typeof item !== 'object') continue;
      const quota = item as Record<string, unknown>;
      out.push({
        ...shared,
        remainingFraction:
          typeof quota.remainingFraction === 'number' ? quota.remainingFraction : undefined,
        resetTime: optionalString(quota.resetTime),
        windowLabel: optionalString(quota.windowLabel) ?? label,
      });
    }
  };
  push(entry.quotaInfo);
  push(entry.quotaInfos);
  push(entry.dailyQuotaInfo, 'Daily');
  push(entry.dailyQuotaInfos, 'Daily');
  push(entry.weeklyQuotaInfo, 'Weekly');
  push(entry.weeklyQuotaInfos, 'Weekly');
  return out;
}

/**
 * 额度窗口。Antigravity 没有独立的额度端点，配额挂在 `fetchAvailableModels`
 * 每个模型条目的 `quotaInfo*` 上，同一后端的多个模型会重复上报，按 label 去重。
 */
export function parseUsageWindows(payload: unknown, nowMs = Date.now()): AntigravityUsageWindow[] {
  if (!payload || typeof payload !== 'object') return [];
  const models = (payload as Record<string, unknown>).models;
  if (!models || typeof models !== 'object' || Array.isArray(models)) return [];

  const byLabel = new Map<string, AntigravityUsageWindow>();
  for (const raw of Object.values(models as Record<string, unknown>)) {
    if (!raw || typeof raw !== 'object') continue;
    for (const quota of collectQuotas(raw as Record<string, unknown>)) {
      const parsedReset = quota.resetTime ? Date.parse(quota.resetTime) : Number.NaN;
      const resetsAt = Number.isFinite(parsedReset) ? parsedReset : undefined;
      // 配额耗尽时后端会省掉 remainingFraction，只留 resetTime —— 那就是 0 剩余
      const remaining = quota.remainingFraction ?? (quota.resetTime ? 0 : undefined);
      if (remaining === undefined) continue;
      const label = quotaLabel(quota, resetsAt, nowMs);
      const clamped = Math.min(1, Math.max(0, remaining));
      const window: AntigravityUsageWindow = {
        label,
        usedPercent: Math.round((1 - clamped) * 100),
        ...(resetsAt !== undefined ? { resetsAt } : {}),
      };
      const existing = byLabel.get(label);
      // 同一 label 取用量最高的那条，别让富余的兄弟计数器盖掉已耗尽的
      if (!existing || window.usedPercent > existing.usedPercent) byLabel.set(label, window);
    }
  }
  return [...byLabel.values()].sort((a, b) => a.label.localeCompare(b.label));
}

export async function fetchAntigravityUsage(
  accessToken: string,
  signal?: AbortSignal
): Promise<AntigravityUsageWindow[]> {
  await ensureAntigravityVersion(fetch, signal);
  return parseUsageWindows(await fetchAvailableModels(accessToken, signal));
}

// ---- 对外契约 ----

export function antigravityProviderConfig(): ProviderConfigInput {
  return {
    name: 'Antigravity (Gemini 3, Claude, GPT-OSS)',
    api: ANTIGRAVITY_API_ID,
    baseUrl: ANTIGRAVITY_PRIMARY_ENDPOINT,
    models: ANTIGRAVITY_FALLBACK_MODELS,
    refreshModels,
    streamSimple: streamAntigravity,
    oauth: {
      name: 'Antigravity',
      isSubscription: true,
      login,
      refreshToken,
      // projectId 必须随 access token 一起送到 streamSimple，序列化成 JSON 塞 apiKey
      getApiKey: (credentials) =>
        JSON.stringify({
          access: credentials.access,
          refresh: credentials.refresh,
          expires: credentials.expires,
          projectId: (credentials as Record<string, unknown>).projectId,
          email: (credentials as Record<string, unknown>).email,
        }),
    },
  };
}
