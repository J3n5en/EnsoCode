import path from 'node:path';
import type { ModelRuntime as ModelRuntimeType } from '@earendil-works/pi-coding-agent';
import type {
  OauthAccountInfo,
  OauthLoginEvent,
  OauthProviderInfo,
  OauthUsageWindow,
} from '@shared/types';
import { IPC_CHANNELS } from '@shared/types';
import { app, shell, type WebContents } from 'electron';

// pi-ai 不在依赖树顶层，auth 交互类型从 ModelRuntime.login 签名结构化提取
type AuthInteraction = Parameters<ModelRuntimeType['login']>[2];
type AuthPrompt = Parameters<AuthInteraction['prompt']>[0];

// 与 agent worker 共用同一 auth.json（pi CredentialStore 文件锁保证跨进程互斥），
// 登录/退出在 Main 完成后，worker 侧请求时经 getAuth 直接读到新凭证
let runtimePromise: Promise<ModelRuntimeType> | null = null;

function getRuntime(): Promise<ModelRuntimeType> {
  runtimePromise ??= (async () => {
    const { ModelRuntime } = await import('@earendil-works/pi-coding-agent');
    return ModelRuntime.create({
      authPath: path.join(app.getPath('userData'), 'agent', 'pi-agent', 'auth.json'),
      modelsPath: null,
      refreshOnCreate: false,
    });
  })();
  return runtimePromise;
}

export async function listOauthProviders(): Promise<OauthProviderInfo[]> {
  const runtime = await getRuntime();
  // 登录态以 auth.json 为准（listCredentials 读文件），兼容外部（pi CLI）写入
  const credentials = await runtime.listCredentials();
  const loggedIn = new Set(
    credentials.filter((info) => info.type === 'oauth').map((info) => info.providerId)
  );
  return runtime
    .getProviders()
    .filter((provider) => provider.auth.oauth)
    .map((provider) => ({
      id: provider.id,
      name: provider.auth.oauth?.name || provider.name,
      loginLabel: provider.auth.oauth?.loginLabel,
      loggedIn: loggedIn.has(provider.id),
      models: provider.getModels().map((model) => model.id),
    }));
}

interface ActiveLogin {
  abort: AbortController;
  pendingPrompts: Map<string, { resolve: (value: string) => void; reject: (err: Error) => void }>;
}

// 同一时刻只允许一个进行中的登录流程
let activeLogin: ActiveLogin | null = null;

export async function startOauthLogin(providerId: string, sender: WebContents): Promise<void> {
  const emit = (event: OauthLoginEvent) => {
    if (!sender.isDestroyed()) sender.send(IPC_CHANNELS.OAUTH_LOGIN_EVENT, event);
  };
  if (activeLogin) {
    emit({ type: 'error', message: 'login already in progress' });
    return;
  }

  const abort = new AbortController();
  const pendingPrompts: ActiveLogin['pendingPrompts'] = new Map();
  activeLogin = { abort, pendingPrompts };

  try {
    const runtime = await getRuntime();
    await runtime.login(providerId, 'oauth', {
      signal: abort.signal,
      notify: (event) => {
        switch (event.type) {
          case 'info':
            emit({ type: 'info', message: event.message });
            break;
          case 'auth_url':
            void shell.openExternal(event.url);
            emit({ type: 'auth_url', url: event.url, instructions: event.instructions });
            break;
          case 'device_code':
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
        return new Promise<string>((resolve, reject) => {
          pendingPrompts.set(requestId, { resolve, reject });
          // 流程侧可能在带外事件（如回调服务器命中）后取消这个 prompt
          prompt.signal?.addEventListener('abort', () => {
            if (pendingPrompts.delete(requestId)) {
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
        });
      },
    });
    emit({ type: 'done', providerId });
  } catch (error) {
    emit({ type: 'error', message: error instanceof Error ? error.message : String(error) });
  } finally {
    for (const pending of pendingPrompts.values()) pending.reject(new Error('login finished'));
    pendingPrompts.clear();
    activeLogin = null;
  }
}

export function respondOauthPrompt(requestId: string, value: string): void {
  const pending = activeLogin?.pendingPrompts.get(requestId);
  if (!pending) return;
  activeLogin?.pendingPrompts.delete(requestId);
  pending.resolve(value);
}

export function cancelOauthLogin(): void {
  activeLogin?.abort.abort();
}

export async function oauthLogout(providerId: string): Promise<void> {
  const runtime = await getRuntime();
  await runtime.logout(providerId);
}

// ---- 账户信息（额度/身份，端点参照 @mtrojnar/pi-usage，MIT）----

const ACCOUNT_TIMEOUT_MS = 10_000;
// anthropic 订阅端点要求 Claude Code 客户端标识
const CLAUDE_CLI_VERSION = '2.1.75';

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

async function fetchJson(
  url: string,
  headers: Record<string, string>
): Promise<Record<string, unknown> | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ACCOUNT_TIMEOUT_MS);
  try {
    const response = await fetch(url, { headers, signal: controller.signal });
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
    return Number.isNaN(parsed) ? undefined : parsed;
  }
  return undefined;
};

const clampPercent = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? Math.min(100, Math.max(0, value)) : null;

const obj = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' ? (value as Record<string, unknown>) : {};

/** anthropic：/api/oauth/usage 的 five_hour/seven_day（utilization 0-100，resets_at ISO） */
async function anthropicWindows(token: string): Promise<OauthUsageWindow[]> {
  const data = await fetchJson('https://api.anthropic.com/api/oauth/usage', {
    Authorization: `Bearer ${token}`,
    'anthropic-beta': 'claude-code-20250219,oauth-2025-04-20',
    'anthropic-version': '2023-06-01',
    'user-agent': `claude-cli/${CLAUDE_CLI_VERSION}`,
    'x-app': 'cli',
    Accept: 'application/json',
  });
  if (!data) return [];
  const windows: OauthUsageWindow[] = [];
  for (const [key, label] of [
    ['five_hour', '5h'],
    ['seven_day', '7d'],
  ] as const) {
    const window = obj(data[key]);
    const usedPercent = clampPercent(window.utilization);
    if (usedPercent === null) continue;
    windows.push({ label, usedPercent, resetsAt: toEpochMs(window.resets_at) });
  }
  return windows;
}

/** codex：backend-api/wham/usage 的 rate_limit 窗口 + plan_type，需 ChatGPT-Account-Id 头 */
async function codexAccount(
  token: string,
  claims: Record<string, unknown> | null
): Promise<Pick<OauthAccountInfo, 'plan' | 'windows'>> {
  const accountId = obj(claims?.['https://api.openai.com/auth']).chatgpt_account_id;
  if (typeof accountId !== 'string' || !accountId) return { windows: [] };
  const data = await fetchJson('https://chatgpt.com/backend-api/wham/usage', {
    Authorization: `Bearer ${token}`,
    'ChatGPT-Account-Id': accountId,
  });
  if (!data) return { windows: [] };

  const windowLabel = (window: Record<string, unknown>, fallback: string): string => {
    const seconds = window.limit_window_seconds;
    if (typeof seconds !== 'number' || seconds <= 0) return fallback;
    return seconds >= 86_400
      ? `${Math.round(seconds / 86_400)}d`
      : `${Math.round(seconds / 3600)}h`;
  };
  const windows: OauthUsageWindow[] = [];
  const rateLimit = obj(data.rate_limit);
  for (const [key, fallback] of [
    ['primary_window', 'primary'],
    ['secondary_window', 'secondary'],
  ] as const) {
    const window = obj(rateLimit[key]);
    const usedPercent = clampPercent(window.used_percent);
    if (usedPercent === null) continue;
    windows.push({
      label: windowLabel(window, fallback),
      usedPercent,
      resetsAt: toEpochMs(window.reset_at),
    });
  }
  const plan = typeof data.plan_type === 'string' ? data.plan_type : undefined;
  return { plan, windows };
}

export async function getOauthAccountInfo(providerId: string): Promise<OauthAccountInfo> {
  const info: OauthAccountInfo = { windows: [] };
  try {
    const runtime = await getRuntime();
    // getAuth 在 store 锁内自动 refresh，拿到的即有效 access token
    const auth = await runtime.getAuth(providerId);
    const token = auth?.auth.apiKey;
    if (!token) return info;

    const claims = decodeJwtPayload(token);
    if (typeof claims?.email === 'string') info.email = claims.email;

    if (providerId === 'anthropic') {
      info.windows = await anthropicWindows(token);
    } else if (providerId === 'openai-codex') {
      const account = await codexAccount(token, claims);
      info.windows = account.windows;
      if (account.plan) info.plan = account.plan;
      // 额度接口不可达时退回 JWT 里的套餐字段
      if (!info.plan) {
        const planType = obj(claims?.['https://api.openai.com/auth']).chatgpt_plan_type;
        if (typeof planType === 'string') info.plan = planType;
      }
    }
  } catch {
    // best-effort：任何失败都返回已收集到的部分
  }
  return info;
}
