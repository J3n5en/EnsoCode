import { isUuid } from './builtinAgents';
import type { ModelProvider } from './types/llm';

export const isCodexAccountKey = (key: unknown): key is string =>
  typeof key === 'string' && /^openai-codex(?:#[2-9]\d*|#1\d+)?$/.test(key);

export interface OauthPoolFailure {
  accountKey: string;
  reason: 'quota-exhausted' | 'login-invalid';
  resetAt?: number;
  /**
   * Main 签发的请求级不透明 UUID；身份和凭证代次只保存在 Main，不由 worker 推导。
   *
   * Main-issued request-scoped opaque UUID; identity and credential generation stay in Main and are never derived by the worker.
   */
  selectionReceipt?: string;
}

export function parseOauthPoolFailure(value: unknown): OauthPoolFailure | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const object = value as Record<string, unknown>;
  return Object.keys(object).every((key) =>
    ['accountKey', 'reason', 'resetAt', 'selectionReceipt'].includes(key)
  ) &&
    isCodexAccountKey(object.accountKey) &&
    (object.selectionReceipt === undefined || isUuid(object.selectionReceipt)) &&
    (object.reason === 'quota-exhausted' || object.reason === 'login-invalid') &&
    (object.resetAt === undefined ||
      (typeof object.resetAt === 'number' && Number.isFinite(object.resetAt) && object.resetAt > 0))
    ? (object as unknown as OauthPoolFailure)
    : null;
}

/**
 * 仅结构化额度码或鉴权失败能换号。SDK 会把普通 429 翻译成 usage limit，故绝不解析其文案。
 *
 * Only structured quota codes or authentication failure allow rotation. SDK renders ordinary 429 as usage limit, so prose is never evidence.
 */
export function classifyCodexPoolFailure(
  status: number,
  body: unknown,
  accountKey: string
): OauthPoolFailure | null {
  if (!isCodexAccountKey(accountKey)) return null;
  const record =
    body && typeof body === 'object' && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : undefined;
  const error =
    record?.error && typeof record.error === 'object' && !Array.isArray(record.error)
      ? (record.error as Record<string, unknown>)
      : undefined;
  const code = error?.code ?? error?.type;
  if (
    status === 401 ||
    ((status === 400 || status === 403) &&
      ['token_expired', 'token_revoked', 'invalid_token', 'invalid_grant'].includes(String(code)))
  ) {
    return { accountKey, reason: 'login-invalid' };
  }
  if (![400, 402, 403, 429].includes(status) || code !== 'usage_limit_reached') return null;
  const reset = error?.resets_at;
  const resetAt =
    typeof reset === 'number' && Number.isFinite(reset * 1000) && reset > 0
      ? reset * 1000
      : undefined;
  return { accountKey, reason: 'quota-exhausted', ...(resetAt ? { resetAt } : {}) };
}

export function parseOauthAccountPool(value: unknown): { accountKeys: string[] } | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const object = value as Record<string, unknown>;
  if (
    Object.keys(object).some((key) => key !== 'accountKeys') ||
    !Array.isArray(object.accountKeys)
  )
    return null;
  const keys = object.accountKeys;
  return keys.length > 0 &&
    keys.length <= 100 &&
    keys.every(isCodexAccountKey) &&
    new Set(keys).size === keys.length
    ? { accountKeys: [...keys] }
    : null;
}

export function isOauthAccountPool(
  provider: Pick<ModelProvider, 'apiKey' | 'oauthAccountKey' | 'oauthAccountPool'>
): boolean {
  return (
    !provider.apiKey &&
    isCodexAccountKey(provider.oauthAccountKey) &&
    parseOauthAccountPool(provider.oauthAccountPool) !== null
  );
}

/**
 * UI 和 Main 共用成员资格：真实登录、固定条目启用且目标模型启用；池不能为自己背书。
 *
 * Shared UI/Main membership: authenticated, enabled fixed entry and enabled model; a pool cannot validate itself.
 */
export function eligibleOauthPoolAccountKeys(
  provider: ModelProvider,
  modelId: string,
  providers: readonly ModelProvider[],
  authenticatedAccountKeys: ReadonlySet<string>
): string[] {
  if (
    !isOauthAccountPool(provider) ||
    !provider.enabled ||
    !provider.models.some((model) => model.id === modelId && model.enabled !== false)
  )
    return [];
  return (provider.oauthAccountPool?.accountKeys ?? []).filter(
    (key) =>
      authenticatedAccountKeys.has(key) &&
      providers.some(
        (entry) =>
          entry.id !== provider.id &&
          entry.oauthAccountPool === undefined &&
          !entry.apiKey &&
          entry.oauthAccountKey === key &&
          entry.enabled &&
          entry.models.some((model) => model.id === modelId && model.enabled !== false)
      )
  );
}
