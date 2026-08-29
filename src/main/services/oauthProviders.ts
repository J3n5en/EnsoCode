import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { ModelRuntime as ModelRuntimeType } from '@earendil-works/pi-coding-agent';
import { isSameChildSessionIdentity } from '@shared/builtinAgents';
import type {
  OauthFlowEvent,
  OauthFlowLocator,
  StartOauthResult,
} from '@shared/capabilities/types';
import {
  ensureAccountProvider,
  nextAccountKey,
  ordinalOfAccountKey,
  supportsMultipleAccounts,
  syncAccountProviders,
} from '@shared/piAccounts';
import {
  ANTIGRAVITY_PROVIDER_ID,
  antigravityProviderConfig,
  fetchAntigravityUsage,
  parseAntigravityApiKey,
  sanitizeUpstreamBody,
} from '@shared/providers/antigravity';
import type {
  OauthAccount,
  OauthAccountUsage,
  OauthLoginEvent,
  OauthProviderInfo,
  OauthUsageWindow,
} from '@shared/types';
import { IPC_CHANNELS, providerIdOfAccountKey, sanitizeOauthLabel } from '@shared/types';
import { app, BrowserWindow, shell, type WebContents } from 'electron';

// pi-ai 不在依赖树顶层，auth 交互类型从 ModelRuntime.login 签名结构化提取
type AuthInteraction = Parameters<ModelRuntimeType['login']>[2];
type AuthPrompt = Parameters<AuthInteraction['prompt']>[0];

/**
 * pi 走动态 import（而不是顶层静态引入）：它连带 pi-ai 的全量 provider catalog，
 * 静态引入会把它挂到 Main 的启动路径上，而这里的功能只在用户打开订阅设置时才需要。
 * ESM 模块注册表自带缓存，重复 `import()` 同一字面量不会重新解析，不必再包一层 memo。
 */
const authPath = (): string => path.join(app.getPath('userData'), 'agent', 'pi-agent', 'auth.json');

// 与 agent worker 共用同一 auth.json（pi CredentialStore 文件锁保证跨进程互斥），
// 登录/退出在 Main 完成后，worker 侧请求时经 getAuth 直接读到新凭证
let runtimePromise: Promise<ModelRuntimeType> | null = null;
const onlineCatalogProviderIds = new Set<string>([ANTIGRAVITY_PROVIDER_ID]);
const onlineCatalogRefreshes = new Map<string, Promise<boolean>>();

/** 订阅设置与模型元数据查询共用同一份 Main 侧 runtime（catalog + auth.json） */
export function getRuntime(): Promise<ModelRuntimeType> {
  runtimePromise ??= (async () => {
    const agentDir = path.join(app.getPath('userData'), 'agent', 'pi-agent');
    process.env.PI_CODING_AGENT_DIR ??= agentDir;
    const { ModelRuntime } = await import('@earendil-works/pi-coding-agent');
    const runtime = await ModelRuntime.create({
      authPath: authPath(),
      modelsPath: null,
      refreshOnCreate: false,
    });
    // Antigravity / Cursor 都不在 pi 内置 catalog 里，先注册基础 provider 再对齐账号克隆；
    // Cursor 的合成账号会由 syncAccountProviders 按单账号能力显式排除
    runtime.registerProvider(ANTIGRAVITY_PROVIDER_ID, antigravityProviderConfig());
    const { CURSOR_PROVIDER_ID, loadCursorProvider } = await import(
      '../../agent/cursor/loadProvider'
    );
    onlineCatalogProviderIds.add(CURSOR_PROVIDER_ID);
    await loadCursorProvider(runtime);
    await syncAccountProviders(runtime);
    // registerProvider 内部只会跑一次 allowNetwork:false 的 refresh（拿到的是兜底清单）。
    // 两个扩展 provider 分开预热；单路发现服务失败不会影响另一条，也不阻塞设置页首开。
    // 元数据查询会 await 同一份 promise，避免首次查询抢在预热前把 unknown 永久写进缓存。
    void ensureProviderModelsRefreshed(runtime, ANTIGRAVITY_PROVIDER_ID);
    void ensureProviderModelsRefreshed(runtime, CURSOR_PROVIDER_ID);
    return runtime;
  })();
  return runtimePromise;
}

/**
 * 联网重拉某个 provider 的模型清单。
 *
 * 为什么必须单独调：`registerProvider` 触发的那次 refresh 是 `allowNetwork: false`，
 * 于是 `refreshModels` 直接返回兜底清单。而 Antigravity 的模型 id 由后端按档位切分
 * （见 `@shared/providers/antigravity` 的 wire id 说明），兜底清单只是近似——
 * 不补这一次联网拉取，用户选到的 id 可能后端并不存在，推理时回 404。
 *
 * 拉取失败不抛：清单退化成兜底表仍可用，不该因此让登录或启动失败。
 */
async function refreshProviderModels(
  runtime: ModelRuntimeType,
  providerId: string
): Promise<boolean> {
  try {
    const result = await runtime.refresh({ providers: [providerId], allowNetwork: true });
    return !result.aborted && result.errors.size === 0;
  } catch {
    // 保持兜底清单；调用方可在下一次元数据查询时重试
    return false;
  }
}

/**
 * 等待扩展 provider 本进程第一次联网 catalog 刷新；内置 provider 无需额外刷新。
 *
 * promise 按基础 provider id 常驻复用：冷启动预热与元数据查询不会重复发请求。登录成功
 * 仍会直接调用 refreshProviderModels，因为新凭证必须强制刷新，不能复用登录前的尝试。
 */
export async function ensureProviderModelsRefreshed(
  runtime: ModelRuntimeType,
  accountKey: string
): Promise<void> {
  const providerId = providerIdOfAccountKey(accountKey);
  if (!onlineCatalogProviderIds.has(providerId)) return;
  let refresh = onlineCatalogRefreshes.get(providerId);
  if (!refresh) {
    refresh = refreshProviderModels(runtime, providerId);
    onlineCatalogRefreshes.set(providerId, refresh);
    void refresh.then((succeeded) => {
      // 成功结果常驻；失败只去重本轮并发，后续查询可重试。这里不另加定时退避：
      // renderer 没有轮询；同波请求已由 promise 去重；provider 自己维护 freshness/backoff，
      // 且这里没有传 force；应用层再延迟会在网络恢复后继续人为留用兜底清单。
      if (!succeeded && onlineCatalogRefreshes.get(providerId) === refresh) {
        onlineCatalogRefreshes.delete(providerId);
      }
    });
  }
  await refresh;
}

// ---- 账号身份缓存 ----

/** 账号的身份信息；只做展示，缺省即界面不渲染对应字段 */
interface AccountIdentity {
  email?: string;
  plan?: string;
}

/**
 * 身份信息存在本应用自己的小文件里，不写进 pi 的 auth.json。
 *
 * 为什么：pi 只暴露 `login` / `logout` 两个写入口，`CredentialStore.modify` 是私有的。
 * 要自己写 auth.json 就得复刻 pi 的 `proper-lockfile` 加锁协议（agent worker 会并发刷新
 * token），代价与风险都远高于一个旁路缓存文件。这里存的全是可再次拉取的展示信息，
 * 丢了只是界面少显示一行。
 */
const metaPath = (): string => path.join(app.getPath('userData'), 'oauth-accounts.json');

let metaCache: Record<string, AccountIdentity> | null = null;

async function readAccountMeta(): Promise<Record<string, AccountIdentity>> {
  if (metaCache) return metaCache;
  try {
    const parsed = JSON.parse(readFileSync(metaPath(), 'utf8')) as unknown;
    metaCache =
      parsed && typeof parsed === 'object' ? (parsed as Record<string, AccountIdentity>) : {};
  } catch {
    // 文件不存在或损坏都当空缓存
    metaCache = {};
  }
  return metaCache;
}

async function writeAccountMeta(
  mutate: (meta: Record<string, AccountIdentity>) => void
): Promise<void> {
  const meta = await readAccountMeta();
  mutate(meta);
  try {
    // 原子写：先写临时文件再重命名，避免崩溃留下半截 JSON
    const target = metaPath();
    const tmp = `${target}.tmp`;
    writeFileSync(tmp, JSON.stringify(meta), { encoding: 'utf8', mode: 0o600 });
    renameSync(tmp, target);
  } catch {
    // 缓存写失败不该影响登录/额度查询本身
  }
}

// ---- 账号枚举 ----

/** 解出 JWT payload；非 JWT / 解析失败返回 null */
function decodeJwtPayload(token: string): Record<string, unknown> | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  try {
    const parsed = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

const obj = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' ? (value as Record<string, unknown>) : {};

/**
 * 从**已存凭证本身**（不发网络请求）能读到的身份信息。
 * 部分厂商的 access token 是 JWT（codex 带 email 与套餐、xai 带数字 tier），
 * anthropic 的是不透明 token，读不出东西——那部分靠 sidecar 缓存补。
 */
function identityFromCredential(providerId: string, access: string): AccountIdentity {
  const claims = decodeJwtPayload(access);
  if (!claims) return {};
  const identity: AccountIdentity = {};
  if (typeof claims.email === 'string') identity.email = claims.email;
  if (providerId === 'openai-codex') {
    const planType = obj(claims['https://api.openai.com/auth']).chatgpt_plan_type;
    if (typeof planType === 'string') assignPlan(identity, planType);
  } else if (providerId === 'xai') {
    const tier = claims.tier;
    if (typeof tier === 'number' || typeof tier === 'string') assignPlan(identity, `tier ${tier}`);
  }
  return identity;
}

/** 空串视为没有档位，避免控制字符被洗掉后还留下一个空白 plan */
function assignPlan(identity: AccountIdentity, raw: string): void {
  const plan = sanitizeOauthLabel(raw);
  if (plan) identity.plan = plan;
}

/** auth.json 里属于某基础 provider 的账号 key，按 key 排序 */
async function accountKeysOf(runtime: ModelRuntimeType): Promise<Map<string, string[]>> {
  const credentials = await runtime.listCredentials();
  const byProvider = new Map<string, string[]>();
  for (const info of credentials) {
    if (info.type !== 'oauth') continue;
    const providerId = providerIdOfAccountKey(info.providerId);
    const keys = byProvider.get(providerId);
    if (keys) keys.push(info.providerId);
    else byProvider.set(providerId, [info.providerId]);
  }
  // 按序号排而不是字典序：`#10` 字典序会插到 `#2` 前面
  for (const keys of byProvider.values()) {
    keys.sort((left, right) => ordinalOfAccountKey(left) - ordinalOfAccountKey(right));
  }
  return byProvider;
}

/**
 * 直接读取 auth.json 中实际存在的全部 OAuth account key。
 * 不初始化 ModelRuntime，不触发 provider 注册、getAuth、token refresh 或网络请求。
 * 文件不存在表示尚无账号；损坏、权限与其它 I/O 错误原样上抛供调用方 fail-closed。
 */
export async function readStoredOauthCredentialKeys(): Promise<ReadonlySet<string>> {
  let raw: string;
  try {
    raw = await readFile(authPath(), 'utf8');
  } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
    if (code === 'ENOENT') return new Set();
    throw error;
  }
  const parsed: unknown = JSON.parse(raw);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Invalid OAuth credential store');
  }
  const keys = new Set<string>();
  for (const [key, credential] of Object.entries(parsed)) {
    if (
      credential &&
      typeof credential === 'object' &&
      !Array.isArray(credential) &&
      'type' in credential &&
      credential.type === 'oauth'
    ) {
      keys.add(key);
    }
  }
  return keys;
}

/** Gateway 值感知脱敏使用；只读 auth.json，不触发 token refresh 或网络。 */
export async function readStoredOauthSecretValues(): Promise<readonly string[]> {
  let raw: string;
  try {
    raw = await readFile(authPath(), 'utf8');
  } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
    if (code === 'ENOENT') return [];
    throw error;
  }
  const parsed: unknown = JSON.parse(raw);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Invalid OAuth credential store');
  }
  const values: string[] = [];
  for (const credential of Object.values(parsed)) {
    if (!credential || typeof credential !== 'object' || Array.isArray(credential)) continue;
    const record = credential as Record<string, unknown>;
    if (record.type !== 'oauth') continue;
    for (const key of ['access', 'refresh', 'accessToken', 'refreshToken', 'apiKey'] as const) {
      const value = record[key];
      if (typeof value === 'string' && value.length > 0) values.push(value);
    }
  }
  return values;
}

/**
 * 该 key 在 auth.json 里确有一条 oauth 凭证吗。
 * Renderer 传来的 accountKey 会被直接当 auth.json 的键用（logout / getAuth），
 * 不收窄就等于把「任意键」的读写能力交给渲染层。
 */
export async function hasStoredAccount(
  runtime: ModelRuntimeType,
  accountKey: string
): Promise<boolean> {
  const credentials = await runtime.listCredentials();
  return credentials.some((info) => info.type === 'oauth' && info.providerId === accountKey);
}

export async function listOauthProviders(): Promise<OauthProviderInfo[]> {
  const runtime = await getRuntime();
  // 登录态以 auth.json 为准（listCredentials 读文件），兼容外部（pi CLI）写入
  await syncAccountProviders(runtime);
  const byProvider = await accountKeysOf(runtime);
  const { readStoredCredential } = await import('@earendil-works/pi-coding-agent');
  const meta = await readAccountMeta();
  const file = authPath();

  const toAccount = (providerId: string, key: string): OauthAccount => {
    // readStoredCredential 是同步无锁读且不发网络请求——列表要快，不能走会触发
    // token refresh 的 runtime.getAuth
    const credential = readStoredCredential(key, file);
    const oauth = credential?.type === 'oauth' ? credential : undefined;
    // 凭证里自带的 email（Antigravity 登录时写进去的；pi 不拒绝额外字段）优先于 JWT 解码，
    // sidecar 是网络探测结果最全，覆盖在最后
    return {
      key,
      providerId,
      ...(oauth ? identityFromCredential(providerId, oauth.access) : {}),
      ...(typeof oauth?.email === 'string' ? { email: oauth.email } : {}),
      ...meta[key],
    };
  };

  return runtime
    .getProviders()
    .filter((provider) => provider.auth.oauth && !provider.id.includes('#'))
    .map((provider) => ({
      id: provider.id,
      name: provider.auth.oauth?.name || provider.name,
      loginLabel: provider.auth.oauth?.loginLabel,
      supportsMultipleAccounts: supportsMultipleAccounts(provider.id),
      accounts: (byProvider.get(provider.id) ?? []).map((key) => toAccount(provider.id, key)),
      models: provider.getModels().map((model) => model.id),
    }));
}

// ---- 登录 / 登出 ----

interface ActiveLogin {
  locator: OauthFlowLocator;
  abort: AbortController;
  pendingPrompts: Map<string, { resolve: (value: string) => void; reject: (err: Error) => void }>;
  resolveCompletion: (event: OauthLoginEvent) => void;
  settled: boolean;
  /** 完整 URL 只留在 Main 内存里，Renderer 需要重开时经专用 IPC 请求 */
  authUrl?: string;
}

// 同一时刻只允许一个进行中的登录流程
let activeLogin: ActiveLogin | null = null;
/** 通知除发起窗口外的 renderer：auth.json 账号集合已变化，需要重拉真值快照。 */
export function broadcastOauthCredentialsChanged(source?: WebContents): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed() || win.webContents === source || win.webContents.isDestroyed()) continue;
    win.webContents.send(IPC_CHANNELS.OAUTH_CREDENTIALS_CHANGED);
  }
}

/** Renderer 只需要展示来源，不得拿到 OAuth 查询参数里的 state 等敏感值 */
function authUrlForRenderer(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return '';
  }
}

export interface OauthLoginHandle {
  start: StartOauthResult;
  completion?: Promise<OauthLoginEvent>;
}

function sameFlow(left: OauthFlowLocator, right: OauthFlowLocator): boolean {
  if (
    left.flowId !== right.flowId ||
    left.host !== right.host ||
    left.ownerWebContentsId !== right.ownerWebContentsId
  ) {
    return false;
  }
  return left.host === 'provider-wizard'
    ? right.host === 'provider-wizard'
    : right.host === 'agent-child-tab' &&
        left.turnId === right.turnId &&
        left.requestId === right.requestId &&
        isSameChildSessionIdentity(left.child, right.child);
}
function emitOauthEvent(login: ActiveLogin, sender: WebContents, event: OauthLoginEvent): void {
  if (!sender.isDestroyed()) {
    const flowEvent: OauthFlowEvent = { locator: login.locator, event };
    sender.send(IPC_CHANNELS.OAUTH_LOGIN_EVENT, flowEvent);
  }
  if (!login.settled && (event.type === 'done' || event.type === 'error')) {
    login.settled = true;
    login.resolveCompletion(event);
  }
}

/** 同一入口服务 wizard 与 Enso child；locator 完整绑定 owner/host/generation/request。 */
export function beginOauthLogin(
  providerId: string,
  sender: WebContents,
  locator: OauthFlowLocator,
  signal?: AbortSignal
): OauthLoginHandle {
  if (sender.isDestroyed() || sender.id !== locator.ownerWebContentsId) {
    return {
      start: { status: 'failed', code: 'invalid-owner', message: 'OAuth owner is unavailable' },
    };
  }
  if (activeLogin) return { start: { status: 'busy', activeHost: activeLogin.locator.host } };
  if (signal?.aborted) {
    return {
      start: { status: 'failed', code: 'cancelled', message: 'OAuth login was cancelled' },
    };
  }
  const abort = new AbortController();
  const { promise: completion, resolve: resolveCompletion } =
    Promise.withResolvers<OauthLoginEvent>();
  const login: ActiveLogin = {
    locator,
    abort,
    pendingPrompts: new Map(),
    resolveCompletion,
    settled: false,
  };
  activeLogin = login;
  setImmediate(() => {
    void runOauthLogin(providerId, sender, login, signal);
  });
  return { start: { status: 'started', locator }, completion };
}

/** Provider wizard 入口；Main 生成 exact locator，完成仅经 OauthFlowEvent 收敛。 */
export function startOauthLogin(providerId: string, sender: WebContents): StartOauthResult {
  const locator: OauthFlowLocator = {
    flowId: crypto.randomUUID(),
    ownerWebContentsId: sender.id,
    host: 'provider-wizard',
  };
  return beginOauthLogin(providerId, sender, locator).start;
}

async function runOauthLogin(
  providerId: string,
  sender: WebContents,
  login: ActiveLogin,
  ownerSignal?: AbortSignal
): Promise<void> {
  const abortFromOwner = () => login.abort.abort();
  ownerSignal?.addEventListener('abort', abortFromOwner, { once: true });
  let runtime: ModelRuntimeType | null = null;
  const emit = (event: OauthLoginEvent) => emitOauthEvent(login, sender, event);
  emit({ type: 'progress', message: 'Starting login...' });
  try {
    runtime = await getRuntime();
    const base = providerId.includes('#') ? undefined : runtime.getProvider(providerId);
    if (!base?.auth.oauth) {
      emit({ type: 'error', message: `unknown oauth provider: ${providerId}` });
      return;
    }
    const credentials = await runtime.listCredentials();
    const accountKey = nextAccountKey(
      providerId,
      credentials.map((info) => info.providerId)
    );
    if (accountKey !== providerId && !supportsMultipleAccounts(providerId)) {
      emit({ type: 'error', message: `${providerId} does not support multiple accounts` });
      return;
    }
    ensureAccountProvider(runtime, accountKey);

    await runtime.login(accountKey, 'oauth', {
      signal: login.abort.signal,
      notify: (event) => {
        switch (event.type) {
          case 'info':
            emit({ type: 'info', message: event.message });
            break;
          case 'auth_url':
            login.authUrl = event.url;
            void shell.openExternal(event.url);
            emit({
              type: 'auth_url',
              url: authUrlForRenderer(event.url),
              instructions: event.instructions,
            });
            break;
          case 'device_code':
            login.authUrl = event.verificationUri;
            void shell.openExternal(event.verificationUri);
            emit({
              type: 'device_code',
              userCode: event.userCode,
              verificationUri: event.verificationUri,
            });
            break;
          case 'progress':
            emit({ type: 'progress', message: event.message });
            break;
        }
      },
      prompt: (prompt: AuthPrompt) => {
        const requestId = crypto.randomUUID();
        const { promise, resolve, reject } = Promise.withResolvers<string>();
        login.pendingPrompts.set(requestId, { resolve, reject });
        prompt.signal?.addEventListener('abort', () => {
          if (login.pendingPrompts.delete(requestId)) {
            emit({ type: 'prompt-cancel', requestId });
            reject(new Error('prompt aborted'));
          }
        });
        emit({
          type: 'prompt',
          prompt: {
            requestId,
            type: prompt.type,
            message: prompt.message,
            placeholder: 'placeholder' in prompt ? prompt.placeholder : undefined,
            options:
              prompt.type === 'select'
                ? prompt.options.map((option) => ({ ...option }))
                : undefined,
          },
        });
        return promise;
      },
    });

    const accountIdentity = await probeIdentity(runtime, accountKey);
    if (accountIdentity.email || accountIdentity.plan) {
      await writeAccountMeta((meta) => {
        meta[accountKey] = accountIdentity;
      });
    }
    await refreshProviderModels(runtime, providerId);
    emit({
      type: 'done',
      providerId,
      account: { key: accountKey, providerId, ...accountIdentity },
    });
    broadcastOauthCredentialsChanged(sender);
  } catch (error) {
    const raw = error instanceof Error ? error.message : String(error);
    emit({ type: 'error', message: sanitizeUpstreamBody(raw).slice(0, 300) });
  } finally {
    ownerSignal?.removeEventListener('abort', abortFromOwner);
    for (const pending of login.pendingPrompts.values()) {
      pending.reject(new Error('login finished'));
    }
    login.pendingPrompts.clear();
    if (!login.settled) emit({ type: 'error', message: 'OAuth login ended unexpectedly' });
    if (activeLogin === login) activeLogin = null;
    if (runtime) await syncAccountProviders(runtime);
  }
}

export function respondOauthPrompt(
  locator: OauthFlowLocator,
  requestId: string,
  value: string
): boolean {
  if (!activeLogin || !sameFlow(activeLogin.locator, locator)) return false;
  const pending = activeLogin.pendingPrompts.get(requestId);
  if (!pending) return false;
  activeLogin.pendingPrompts.delete(requestId);
  pending.resolve(value);
  return true;
}

export function cancelOauthLogin(locator: OauthFlowLocator): boolean {
  if (!activeLogin || !sameFlow(activeLogin.locator, locator)) return false;
  activeLogin.abort.abort();
  return true;
}

/** 重新打开完整授权地址；任何 locator 字段不匹配均拒绝。 */
export function reopenOauthLogin(locator: OauthFlowLocator): boolean {
  if (!activeLogin || !sameFlow(activeLogin.locator, locator) || !activeLogin.authUrl) {
    return false;
  }
  void shell.openExternal(activeLogin.authUrl).catch(() => {});
  return true;
}

/**
 * 登出单个账号。
 *
 * 不需要「把 `#n` 账号提升成裸 key」：克隆的基底是 pi **内置 catalog** 里的 provider，
 * 它与凭证无关，auth.json 全空时依然存在（实测 probe3）。而新账号的 key 由
 * `nextAccountKey` 递增分配、不回收空位，所以裸 key 空着也不会撞号。
 */
export async function oauthLogout(accountKey: string, sender?: WebContents): Promise<void> {
  const runtime = await getRuntime();
  // accountKey 来自 Renderer，只接受 auth.json 里真实存在的键：
  // 任意字符串都能当键传进 pi 的 logout/getAuth，先按已存凭证收窄
  if (!(await hasStoredAccount(runtime, accountKey))) return;
  await runtime.logout(accountKey);
  await syncAccountProviders(runtime);
  await writeAccountMeta((meta) => {
    delete meta[accountKey];
  });
  broadcastOauthCredentialsChanged(sender);
}

// ---- 额度（端点参照 @mtrojnar/pi-usage，MIT）----

const ACCOUNT_TIMEOUT_MS = 10_000;
// anthropic 订阅端点要求 Claude Code 客户端标识
const CLAUDE_CLI_VERSION = '2.1.75';

async function fetchJson(
  url: string,
  headers: Record<string, string>,
  init?: Pick<RequestInit, 'method' | 'body'>
): Promise<Record<string, unknown> | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ACCOUNT_TIMEOUT_MS);
  try {
    const response = await fetch(url, { headers, signal: controller.signal, ...init });
    if (!response.ok) return null;
    const data = (await response.json()) as unknown;
    return data && typeof data === 'object' ? (data as Record<string, unknown>) : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

const toEpochMs = (value: unknown): number | undefined => {
  if (typeof value === 'number' && Number.isFinite(value)) {
    // 秒/毫秒歧义：小于 1e12 视为秒
    return value < 1e12 ? value * 1000 : value;
  }
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    if (!Number.isNaN(parsed)) return parsed;
    const numeric = Number(value);
    if (Number.isFinite(numeric)) return numeric < 1e12 ? numeric * 1000 : numeric;
  }
  return undefined;
};

const clampPercent = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? Math.min(100, Math.max(0, value)) : null;

/** xAI billing 把金额包成 `{ val }`；裸 number 也收 */
const unwrapAmount = (value: unknown): number | undefined => {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const inner = obj(value).val;
  return typeof inner === 'number' && Number.isFinite(inner) ? inner : undefined;
};

/** 单个账号的探测结果：身份 + 额度窗口 */
interface AccountProbe extends AccountIdentity {
  windows: OauthUsageWindow[];
}

/** anthropic：/api/oauth/usage 的 five_hour/seven_day（utilization 0-100，resets_at ISO） */
async function anthropicProbe(token: string): Promise<AccountProbe> {
  const probe: AccountProbe = { windows: [] };
  const headers = {
    Authorization: `Bearer ${token}`,
    'anthropic-beta': 'claude-code-20250219,oauth-2025-04-20',
    'anthropic-version': '2023-06-01',
    'user-agent': `claude-cli/${CLAUDE_CLI_VERSION}`,
    'x-app': 'cli',
    Accept: 'application/json',
  };
  // access token 是不透明串（非 JWT），身份只能问服务端。
  // /api/oauth/profile 与 /api/oauth/usage 同属 Claude Code 的未公开端点，
  // 取不到就不显示，不影响主流程
  const profile = await fetchJson('https://api.anthropic.com/api/oauth/profile', headers);
  const email = obj(profile?.account).email_address;
  if (typeof email === 'string') probe.email = email;

  const data = await fetchJson('https://api.anthropic.com/api/oauth/usage', headers);
  if (!data) return probe;
  for (const [key, label] of [
    ['five_hour', '5h'],
    ['seven_day', '7d'],
  ] as const) {
    const window = obj(data[key]);
    const usedPercent = clampPercent(window.utilization);
    if (usedPercent === null) continue;
    probe.windows.push({ label, usedPercent, resetsAt: toEpochMs(window.resets_at) });
  }
  return probe;
}

/** codex：backend-api/wham/usage 的 rate_limit 窗口 + plan_type，需 ChatGPT-Account-Id 头 */
async function codexProbe(
  token: string,
  claims: Record<string, unknown> | null
): Promise<AccountProbe> {
  const probe: AccountProbe = { windows: [] };
  const accountId = obj(claims?.['https://api.openai.com/auth']).chatgpt_account_id;
  if (typeof accountId !== 'string' || !accountId) return probe;
  const data = await fetchJson('https://chatgpt.com/backend-api/wham/usage', {
    Authorization: `Bearer ${token}`,
    'ChatGPT-Account-Id': accountId,
  });
  if (!data) return probe;

  const windowLabel = (window: Record<string, unknown>, fallback: string): string => {
    const seconds = window.limit_window_seconds;
    if (typeof seconds !== 'number' || seconds <= 0) return fallback;
    return seconds >= 86_400
      ? `${Math.round(seconds / 86_400)}d`
      : `${Math.round(seconds / 3600)}h`;
  };
  const rateLimit = obj(data.rate_limit);
  for (const [key, fallback] of [
    ['primary_window', 'primary'],
    ['secondary_window', 'secondary'],
  ] as const) {
    const window = obj(rateLimit[key]);
    const usedPercent = clampPercent(window.used_percent);
    if (usedPercent === null) continue;
    probe.windows.push({
      label: windowLabel(window, fallback),
      usedPercent,
      resetsAt: toEpochMs(window.reset_at),
    });
  }
  if (typeof data.plan_type === 'string') assignPlan(probe, data.plan_type);
  return probe;
}

/**
 * xai：email 走 OIDC userinfo；额度走 Grok CLI billing（oh-my-pi xai-oauth）。
 * 先 `?format=credits` 拿周池；unified 账号缺周百分比时再打默认月池。
 */
async function xaiProbe(token: string): Promise<AccountProbe> {
  const probe: AccountProbe = { windows: [] };
  const billingHeaders = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/json',
    'X-XAI-Token-Auth': 'xai-grok-cli',
  };
  const [userinfo, credits] = await Promise.all([
    fetchJson('https://auth.x.ai/oauth2/userinfo', { Authorization: `Bearer ${token}` }),
    fetchJson('https://cli-chat-proxy.grok.com/v1/billing?format=credits', billingHeaders),
  ]);
  if (typeof userinfo?.email === 'string') probe.email = userinfo.email;

  const creditsConfig = obj(credits?.config);
  const weekly = parseXaiWeekly(creditsConfig);
  const unified = creditsConfig.isUnifiedBillingUser === true;
  let monthly: OauthUsageWindow | null = null;
  if (!weekly || unified) {
    const monthlyData = await fetchJson(
      'https://cli-chat-proxy.grok.com/v1/billing',
      billingHeaders
    );
    monthly = parseXaiMonthly(obj(monthlyData?.config));
  }
  // unified 且周百分比是缺省推断的 0%：月池才是真实额度，丢掉推断周窗
  if (weekly && !(weekly.inferred && monthly)) {
    probe.windows.push({
      label: '7d',
      usedPercent: weekly.usedPercent,
      resetsAt: weekly.resetsAt,
    });
  }
  if (monthly) probe.windows.push(monthly);
  return probe;
}

function parseXaiWeekly(
  config: Record<string, unknown>
): { usedPercent: number; resetsAt?: number; inferred: boolean } | null {
  const period = obj(config.currentPeriod);
  const type = typeof period.type === 'string' ? period.type : '';
  const start = toEpochMs(period.start);
  const end = toEpochMs(period.end);
  if (
    start === undefined ||
    end === undefined ||
    end <= start ||
    !type.toUpperCase().includes('WEEK')
  ) {
    return null;
  }
  const inferred = config.creditUsagePercent === undefined || config.creditUsagePercent === null;
  const usedPercent = inferred
    ? end > Date.now()
      ? 0
      : null
    : clampPercent(config.creditUsagePercent);
  if (usedPercent === null) return null;
  return { usedPercent, resetsAt: end, inferred };
}

function parseXaiMonthly(config: Record<string, unknown>): OauthUsageWindow | null {
  const limit = unwrapAmount(config.monthlyLimit);
  const used = unwrapAmount(config.used);
  if (limit === undefined || limit <= 0 || used === undefined) return null;
  return {
    label: 'mo',
    usedPercent: Math.min(100, Math.max(0, (used / limit) * 100)),
    resetsAt: toEpochMs(config.billingPeriodEnd),
  };
}

function cursorUserId(token: string): string | undefined {
  const sub = decodeJwtPayload(token)?.sub;
  if (typeof sub !== 'string' || !sub) return undefined;
  const pipe = sub.indexOf('|');
  const userId = (pipe === -1 ? sub : sub.slice(pipe + 1)).trim();
  return userId || undefined;
}

function cursorSessionHeaders(userId: string, token: string): Record<string, string> {
  return {
    Accept: 'application/json',
    Cookie: `WorkosCursorSessionToken=${encodeURIComponent(`${userId}::${token}`)}`,
  };
}

function cursorResetsAt(payload: Record<string, unknown>): number | undefined {
  for (const key of ['billingCycleEnd', 'endOfMonth', 'resetsAt', 'nextReset'] as const) {
    const parsed = toEpochMs(payload[key]);
    if (parsed !== undefined) return parsed;
  }
  return undefined;
}

/** Cursor Pro+ 仪表盘：Cursor Models ← autoPercentUsed，Other Models ← apiPercentUsed */
function cursorPlanWindows(bucket: Record<string, unknown>, resetsAt?: number): OauthUsageWindow[] {
  if (bucket.enabled === false) return [];
  const autoPct = clampPercent(bucket.autoPercentUsed);
  const apiPct = clampPercent(bucket.apiPercentUsed);
  const totalPct = clampPercent(bucket.totalPercentUsed);
  const windows: OauthUsageWindow[] = [];
  if (autoPct !== null) windows.push({ label: 'auto', usedPercent: autoPct, resetsAt });
  if (apiPct !== null) windows.push({ label: 'api', usedPercent: apiPct, resetsAt });
  if (windows.length === 0 && totalPct !== null) {
    windows.push({ label: 'plan', usedPercent: totalPct, resetsAt });
  }
  return windows;
}

function parseCursorSummary(payload: Record<string, unknown> | null): OauthUsageWindow[] {
  const individual = obj(payload?.individualUsage);
  if (!payload || Object.keys(individual).length === 0) return [];
  const resetsAt = cursorResetsAt(payload);
  const plan = obj(individual.plan);
  const overall = obj(individual.overall);
  const fromPlan = cursorPlanWindows(plan, resetsAt);
  if (fromPlan.length > 0) return fromPlan;
  const limit = unwrapAmount(overall.limit);
  const used = unwrapAmount(overall.used);
  if (limit !== undefined && limit > 0 && used !== undefined) {
    return [
      {
        label: 'plan',
        usedPercent: Math.min(100, Math.max(0, (used / limit) * 100)),
        resetsAt,
      },
    ];
  }
  return [];
}

function parseCursorPeriodUsage(payload: Record<string, unknown> | null): OauthUsageWindow[] {
  if (!payload) return [];
  return cursorPlanWindows(obj(payload.planUsage), cursorResetsAt(payload));
}

/**
 * cursor：oh-my-pi 的 usage-summary（session cookie）优先；
 * Bearer 打 DashboardService/GetCurrentPeriodUsage 作无 JWT 时的退路。
 */
async function cursorProbe(token: string): Promise<AccountProbe> {
  const probe: AccountProbe = { windows: [] };
  const userId = cursorUserId(token);
  const session = userId ? cursorSessionHeaders(userId, token) : null;
  const [summary, period, me] = await Promise.all([
    session ? fetchJson('https://cursor.com/api/usage-summary', session) : Promise.resolve(null),
    fetchJson(
      'https://api2.cursor.sh/aiserver.v1.DashboardService/GetCurrentPeriodUsage',
      {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'Connect-Protocol-Version': '1',
      },
      { method: 'POST', body: '{}' }
    ),
    session ? fetchJson('https://cursor.com/api/auth/me', session) : Promise.resolve(null),
  ]);
  if (typeof me?.email === 'string') probe.email = me.email;
  probe.windows = parseCursorSummary(summary);
  if (probe.windows.length === 0) probe.windows = parseCursorPeriodUsage(period);
  return probe;
}

/**
 * antigravity：`getApiKey` 把整条凭证序列化成 JSON 塞在 apiKey 里
 * （projectId 必须随 access token 一起送到 streamSimple），所以这里要先解开，
 * **不能把整段 JSON 当 Bearer 去打 Google 的额度接口**。email 也在这条 JSON 里，本地可得。
 */
async function antigravityProbe(apiKeyRaw: string): Promise<AccountProbe> {
  const credentials = parseAntigravityApiKey(apiKeyRaw);
  const probe: AccountProbe = {
    windows: [],
    ...(credentials.email ? { email: credentials.email } : {}),
  };
  probe.windows = await fetchAntigravityUsage(credentials.access);
  return probe;
}

/** 按基础 provider 分派探测；未接入额度端点的 provider 返回空窗口而不是报错 */
async function probeAccount(runtime: ModelRuntimeType, accountKey: string): Promise<AccountProbe> {
  ensureAccountProvider(runtime, accountKey);
  // getAuth 在 store 锁内自动 refresh；多数 provider 的 apiKey 就是 access token。
  // Cursor 的 getApiKey 返回占位符 `cursor-native`（真 token 由 pi-cursor 另取），
  // 所以 refresh 之后改读 auth.json 里的 oauth.access。
  const auth = await runtime.getAuth(accountKey);
  const providerId = providerIdOfAccountKey(accountKey);
  const apiKey = auth?.auth.apiKey;
  let token = apiKey;
  if (providerId === 'cursor') {
    const { readStoredCredential } = await import('@earendil-works/pi-coding-agent');
    const credential = readStoredCredential(accountKey, authPath());
    token = credential?.type === 'oauth' ? credential.access : apiKey;
  }
  if (!token) throw new Error(`no credential for account: ${accountKey}`);
  const claims = decodeJwtPayload(token);
  const fromToken = identityFromCredential(providerId, token);
  const probe =
    providerId === 'anthropic'
      ? await anthropicProbe(token)
      : providerId === 'openai-codex'
        ? await codexProbe(token, claims)
        : providerId === 'xai'
          ? await xaiProbe(token)
          : providerId === 'cursor'
            ? await cursorProbe(token)
            : providerId === ANTIGRAVITY_PROVIDER_ID
              ? await antigravityProbe(token)
              : { windows: [] as OauthUsageWindow[] };
  // 网络结果优先，缺的字段用 token 里读到的兜底
  return sanitizeAccountProbe({ ...fromToken, ...probe });
}

/** 所有探测出口过同一道限长，避免某个厂商忘了在赋值处调用 sanitizeOauthLabel */
function sanitizeAccountProbe(probe: AccountProbe): AccountProbe {
  const { plan: rawPlan, windows, ...rest } = probe;
  const plan = rawPlan !== undefined ? sanitizeOauthLabel(rawPlan) : '';
  return {
    ...rest,
    ...(plan ? { plan } : {}),
    windows: windows.map((window) => ({
      ...window,
      label: sanitizeOauthLabel(window.label),
    })),
  };
}

/** 身份探测：登录成功后写 sidecar 用，额度部分丢弃 */
async function probeIdentity(
  runtime: ModelRuntimeType,
  accountKey: string
): Promise<AccountIdentity> {
  try {
    const { windows: _windows, ...identity } = await probeAccount(runtime, accountKey);
    return identity;
  } catch {
    // best-effort：探不到就不显示
    return {};
  }
}

/** 单个账号的额度详情；拉取失败填 error 而不是抛，界面才能区分「没数据」与「挂了」 */
export async function getOauthAccountUsage(accountKey: string): Promise<OauthAccountUsage> {
  try {
    const runtime = await getRuntime();
    // 同 oauthLogout：不收窄的话渲染层能拿任意 auth.json 键去触发 getAuth 与克隆注册
    if (!(await hasStoredAccount(runtime, accountKey))) {
      return { key: accountKey, windows: [], error: `unknown account: ${accountKey}` };
    }
    const { windows, ...identity } = await probeAccount(runtime, accountKey);
    if (identity.email || identity.plan) {
      await writeAccountMeta((meta) => {
        meta[accountKey] = { ...meta[accountKey], ...identity };
      });
    }
    return { key: accountKey, windows };
  } catch (error) {
    return {
      key: accountKey,
      windows: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
