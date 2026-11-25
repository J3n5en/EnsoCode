import {
  type DefaultModelRef,
  type ModelCredentialContext,
  type ModelUsability,
  modelUsability,
} from '../../../shared/defaultModel';
import { materializeProviders } from '../../../shared/modelDirectory';
import type { SpawnModelConfig } from '../../../shared/types/agent';
import type { BotEngine } from '../../../shared/types/bot';
import type { ModelProvider } from '../../../shared/types/llm';
import { findVirtualModel, isVirtualRef, parseVirtualModels } from '../../../shared/virtualModels';
import { getModelDirectorySnapshot } from '../modelDirectory';
import { pickBotModel } from './botPrompt';

/** 实测成员模型的最短往返：worker 真实模型栈发一次性补全 */
const PROBE_TIMEOUT_MS = 15_000;
/** 探测输出预算：太小会在 thinking 模型的思维链阶段就用尽，正文为空（对齐 providerApi 的 TEST_MAX_OUTPUT_TOKENS） */
const PROBE_MAX_TOKENS = 256;
const PROBE_FAILURE_TTL_MS = 60_000;
const PROBE_ERROR_MAX = 80;
const MODEL_FAILURES = new Set([
  '鉴权失败',
  '当前地区不可用',
  '请求被限流',
  '模型不存在',
  '网络连接失败',
  '调用超时',
]);

export type ModelProbeResult =
  | {
      ok: true;
      model?: DefaultModelRef;
      fallback?: { model: DefaultModelRef; label: string; reason: string };
    }
  | { ok: false; error: string };

type ProbeStatus = { ok: true } | { ok: false; error: string };

export type ModelProbe = ((engine: BotEngine | undefined) => Promise<ModelProbeResult>) & {
  /** 真实投递报模型错误后作废该成员用过的测通结果 */
  invalidate(engine: BotEngine | undefined): void;
};

export interface ModelProbeDeps {
  now?: () => number;
  settings(): Record<string, unknown> | undefined;
  credentials(): Promise<ReadonlySet<string>>;
  resolve(
    ref: DefaultModelRef,
    keys: ReadonlySet<string>
  ): { ok: true; config: SpawnModelConfig } | { ok: false; error: string };
  isWorkerReady(): boolean;
  complete(request: {
    systemPrompt: string;
    userText: string;
    candidates: SpawnModelConfig[];
    timeoutMs: number;
    maxTokens: number;
  }): Promise<string>;
}

function providersFrom(state: Record<string, unknown> | undefined): ModelProvider[] {
  const providers = state?.providers;
  const raw = Array.isArray(providers)
    ? providers.filter(
        (provider): provider is ModelProvider =>
          Boolean(provider) &&
          typeof provider === 'object' &&
          typeof (provider as ModelProvider).id === 'string'
      )
    : [];
  return materializeProviders(raw, getModelDirectorySnapshot());
}

/** 展示用模型名：虚拟条目用其名字，物理模型用「模型 id (供应商名)」 */
export function modelLabel(
  state: Record<string, unknown> | undefined,
  ref: DefaultModelRef
): string {
  if (isVirtualRef(ref))
    return findVirtualModel(parseVirtualModels(state?.virtualModels), ref)?.name ?? ref.modelId;
  const provider = providersFrom(state).find((item) => item.id === ref.providerId);
  return provider ? `${ref.modelId} (${provider.name})` : ref.modelId;
}

function usabilityReasonText(reason: ModelUsability): string {
  switch (reason) {
    case 'missing-selection':
      return '未配置模型';
    case 'provider-missing':
      return '找不到服务商';
    case 'provider-disabled':
      return '服务商已停用';
    case 'classifier-only':
      return '仅用于分类，不能聊天';
    case 'model-missing':
      return '模型不存在';
    case 'model-disabled':
      return '模型已停用';
    case 'api-key-missing':
      return '缺少 API Key';
    case 'oauth-account-missing':
      return '订阅账号不可用';
    case 'oauth-credentials-loading':
      return '订阅凭证加载中';
    case 'oauth-credentials-error':
      return '订阅凭证读取失败';
    default:
      return '未加载订阅凭证';
  }
}

/** 配置层面为什么不可用；给「哪个模型 + 原因」的可读一句 */
export function describeModelIssue(
  state: Record<string, unknown> | undefined,
  ref: DefaultModelRef,
  keys?: ReadonlySet<string>
): string {
  const credentials: ModelCredentialContext = {
    oauthCredentials: {
      status: 'ready',
      authenticatedAccountKeys: keys ?? new Set<string>(),
    },
  };
  const reason = modelUsability(
    ref,
    providersFrom(state),
    credentials,
    parseVirtualModels(state?.virtualModels)
  );
  return `模型 ${modelLabel(state, ref)} 不可用：${usabilityReasonText(reason)}`;
}

/** 底层错误归类成一句原因；已可读的（含「：」或纯中文）原文透出并截断 */
export function briefErrorReason(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error ?? '');
  const text = message.trim();
  if (!text) return '未知错误';
  if (/^agent worker is not running/i.test(text)) return '会话服务未启动';
  if (/aborted|cancelled|canceled/i.test(text)) return '已取消';
  if (/model[- ]missing/.test(text)) return '模型不存在';
  if (/not available in your region|territory not supported|unsupported_country/i.test(text))
    return '当前地区不可用';
  // worker 的 empty completion = 模型已经响应，只是没有正文（输出预算被思维链用尽 / 只回思考）。
  // 必须在 401/403 归类之前：错误串首是 provider 标识，UUID 恰好含 401/403 时会被改判成鉴权失败。
  if (/: empty completion$/.test(text)) return '模型没有返回正文';
  const classified =
    /401|403|unauthorized|forbidden|authentication|invalid.{0,20}(key|token)|api.?key/i.test(text)
      ? '鉴权失败'
      : /429|rate.?limit|too many requests/i.test(text)
        ? '请求被限流'
        : /404|model.{0,20}(not found|does not exist|不存在)|no such model/i.test(text)
          ? '模型不存在'
          : /fetch failed|connection error|econn|enotfound|eai_again|socket|network|econnreset|dns|getaddrinfo|etimedout/i.test(
                text
              )
            ? '网络连接失败'
            : /timed? ?out|timeout|超时/i.test(text)
              ? '调用超时'
              : null;
  const reason = classified ?? text;
  return reason.length > PROBE_ERROR_MAX ? `${reason.slice(0, PROBE_ERROR_MAX)}…` : reason;
}

/** 解析失败原因行：'Model is unavailable: <reason>' → 可读原因；模型名取 label */
function resolveErrorText(
  state: Record<string, unknown> | undefined,
  ref: DefaultModelRef,
  error: string
): string {
  const match = /^Model is unavailable: (.+)$/.exec(error);
  const reason = match
    ? (usabilityReasonText(match[1] as ModelUsability) ?? match[1])
    : briefErrorReason(error);
  return `模型 ${modelLabel(state, ref)}：${reason}`;
}

/** 真实投递的错误是否属于模型类（鉴权、模型不存在、网络、超时、限流） */
export function isModelFailure(error: unknown): boolean {
  return MODEL_FAILURES.has(briefErrorReason(error));
}

/** 成员完整备用链实测，整链失败才尝试默认；测通一直有效直到配置变化或被作废，失败缓存 60 秒。 */
export function createModelProbe(deps: ModelProbeDeps): ModelProbe {
  const cache = new Map<string, { result: ProbeStatus; until: number }>();
  const pending = new Map<string, Promise<ProbeStatus>>();
  const used = new Map<string, Set<string>>();
  const now = deps.now ?? Date.now;
  const engineKey = (engine: BotEngine | undefined) =>
    engine ? JSON.stringify([engine.providerId, engine.modelId]) : '';
  const ping = (candidates: SpawnModelConfig[], touched: Set<string>): Promise<ProbeStatus> => {
    const signature = JSON.stringify(candidates);
    touched.add(signature);
    const cached = cache.get(signature);
    if (cached && cached.until > now()) return Promise.resolve(cached.result);
    const running = pending.get(signature);
    if (running) return running;
    const request = (async (): Promise<ProbeStatus> => {
      let result: ProbeStatus;
      try {
        await deps.complete({
          systemPrompt: 'You are a connectivity check. Reply with OK.',
          userText: 'ping',
          candidates,
          timeoutMs: PROBE_TIMEOUT_MS,
          maxTokens: PROBE_MAX_TOKENS,
        });
        result = { ok: true };
      } catch (error) {
        result = { ok: false, error: briefErrorReason(error) };
      }
      cache.set(signature, {
        result,
        until: result.ok ? Number.POSITIVE_INFINITY : now() + PROBE_FAILURE_TTL_MS,
      });
      return result;
    })();
    pending.set(signature, request);
    void request.finally(() => pending.delete(signature));
    return request;
  };
  const probe = async (engine: BotEngine | undefined): Promise<ModelProbeResult> => {
    const state = deps.settings();
    let keys: ReadonlySet<string>;
    try {
      keys = await deps.credentials();
    } catch {
      return { ok: false, error: '模型凭证读取失败' };
    }
    if (!deps.isWorkerReady()) return { ok: false, error: '会话服务未启动' };
    const touched = new Set<string>();
    used.set(engineKey(engine), touched);
    const check = async (ref: DefaultModelRef): Promise<ModelProbeResult> => {
      const resolved = deps.resolve(ref, keys);
      if (!resolved.ok) return { ok: false, error: resolveErrorText(state, ref, resolved.error) };
      const virtual = resolved.config.virtual;
      const candidates = virtual
        ? [virtual.primary, ...virtual.fallbacks, ...(virtual.fast ? [virtual.fast] : [])]
        : [resolved.config];
      let error = '未知错误';
      for (const [index, config] of candidates.entries()) {
        const tested = await ping([config], touched);
        if (tested.ok) {
          // 401 等永久错误不会触发 worker 的自动重试，本轮必须直接用已测通的备用。
          return index === 0
            ? { ok: true }
            : {
                ok: true,
                model: { providerId: config.settingsProviderId, modelId: config.modelId },
              };
        }
        error = tested.error;
      }
      return { ok: false, error: `模型 ${modelLabel(state, ref)}：${error}` };
    };
    const fallback = pickBotModel(undefined, state ?? {}, () => true);
    if (!engine) return fallback ? check(fallback) : { ok: false, error: '未配置可用模型' };
    const member = await check(engine);
    if (member.ok) return member;
    if (fallback?.providerId === engine.providerId && fallback.modelId === engine.modelId)
      return { ok: false, error: `成员${member.error}；默认${member.error}` };
    const result = fallback
      ? await check(fallback)
      : { ok: false as const, error: '未配置可用模型' };
    if (!result.ok) return { ok: false, error: `成员${member.error}；默认${result.error}` };
    return {
      ok: true,
      fallback: {
        model: result.model ?? { providerId: fallback!.providerId, modelId: fallback!.modelId },
        label: modelLabel(state, fallback!),
        reason: member.error,
      },
    };
  };
  return Object.assign(probe, {
    invalidate(engine: BotEngine | undefined) {
      for (const signature of used.get(engineKey(engine)) ?? [])
        if (cache.get(signature)?.result.ok) cache.delete(signature);
    },
  });
}
