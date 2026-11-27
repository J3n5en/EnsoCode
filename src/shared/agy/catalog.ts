import {
  AGY_DEFAULT_MODEL_ID,
  AGY_MIN_VERSION,
  AGY_PROVIDER_ID,
  SIGNED_OUT_NO_BROWSER,
} from './constants';
import type { AgyAuthStatus, AgyModelOption } from './types';
import { agyVersionAtLeast, parseAgyVersion } from './version';

const THINKING_RANK = ['off', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function selectOptions(option: Record<string, unknown>): AgyModelOption[] {
  if (!Array.isArray(option.options)) return [];
  const models: AgyModelOption[] = [];
  for (const entry of option.options) {
    const row = record(entry);
    if (!row || typeof row.value !== 'string' || !row.value) continue;
    models.push({
      id: row.value,
      name: typeof row.name === 'string' && row.name ? row.name : row.value,
    });
  }
  return models;
}

/** 模型目录用 configOptions 里 id 为 model 的 select。没有时才用 availableModels。 */
export function modelsFromSessionResult(result: unknown): AgyModelOption[] {
  const root = record(result);
  const options = Array.isArray(root?.configOptions) ? root.configOptions : [];
  for (const option of options) {
    const row = record(option);
    if (row?.id === 'model' && row.type === 'select') {
      const models = selectOptions(row);
      if (models.length > 0) return models;
    }
  }
  const available = record(root?.models);
  if (!Array.isArray(available?.availableModels)) return [];
  const models: AgyModelOption[] = [];
  for (const entry of available.availableModels) {
    const row = record(entry);
    const id = typeof row?.modelId === 'string' ? row.modelId : '';
    if (!id) continue;
    models.push({ id, name: typeof row?.name === 'string' && row.name ? row.name : id });
  }
  return models;
}

export function isSignedOutError(code: number | undefined, message: string | undefined): boolean {
  if (code === -32000) return true;
  return code === -32603 && (message ?? '').startsWith(SIGNED_OUT_NO_BROWSER);
}

export function classifyAuthProbe(input: {
  found: boolean;
  version?: string;
  sessionId?: string;
  result?: unknown;
  errorCode?: number;
  errorMessage?: string;
  timedOut?: boolean;
}): AgyAuthStatus {
  if (!input.found) return { status: 'not-installed' };
  if (input.timedOut) return { status: 'unknown' };
  const version = input.version ?? '';
  if (!parseAgyVersion(version) || !agyVersionAtLeast(version, AGY_MIN_VERSION)) {
    return version ? { status: 'too-old', version } : { status: 'unknown' };
  }
  if (input.sessionId) {
    return { status: 'signed-in', version, models: modelsFromSessionResult(input.result) };
  }
  if (isSignedOutError(input.errorCode, input.errorMessage))
    return { status: 'signed-out', version };
  return { status: 'unknown' };
}

export function modelToSet(modelId: string, models: readonly AgyModelOption[]): string | undefined {
  if (
    modelId === AGY_DEFAULT_MODEL_ID ||
    modelId === `${AGY_PROVIDER_ID}/${AGY_DEFAULT_MODEL_ID}`
  ) {
    return undefined;
  }
  const bare = modelId.startsWith(`${AGY_PROVIDER_ID}/`)
    ? modelId.slice(AGY_PROVIDER_ID.length + 1)
    : modelId;
  return models.some((model) => model.id === bare) ? bare : undefined;
}

export function nearestThinking(level: string, options: readonly string[]): string | undefined {
  if (options.length === 0) return undefined;
  if (options.includes(level)) return level;
  const wanted = THINKING_RANK.indexOf(level);
  if (wanted < 0) return options[0];
  let best = options[0];
  let distance = Number.POSITIVE_INFINITY;
  for (const option of options) {
    const rank = THINKING_RANK.indexOf(option);
    if (rank < 0) continue;
    const next = Math.abs(rank - wanted);
    if (next < distance) {
      distance = next;
      best = option;
    }
  }
  return best;
}

/** IPC 返回值按 unknown 收窄：形状不对一律当 unknown。 */
export function parseAgyAuthStatus(value: unknown): AgyAuthStatus {
  const row = record(value);
  const version = typeof row?.version === 'string' ? row.version : '';
  switch (row?.status) {
    case 'signed-in': {
      if (!version) break;
      return { status: 'signed-in', version, models: parseAgyModels(row.models) };
    }
    case 'signed-out':
      return version ? { status: 'signed-out', version } : { status: 'unknown' };
    case 'too-old':
      return version ? { status: 'too-old', version } : { status: 'unknown' };
    case 'not-installed':
      return { status: 'not-installed' };
  }
  return { status: 'unknown' };
}

/** 模型清单（IPC 返回值、落盘缓存）按 unknown 收窄：不是数组当空，坏条目丢掉。 */
export function parseAgyModels(value: unknown): AgyModelOption[] {
  const models: AgyModelOption[] = [];
  for (const entry of Array.isArray(value) ? value : []) {
    const model = record(entry);
    if (typeof model?.id !== 'string' || !model.id) continue;
    models.push({
      id: model.id,
      name: typeof model.name === 'string' && model.name ? model.name : model.id,
    });
  }
  return models;
}

/**
 * picker 与 worker 共用的 agy 模型口径（「默认」由 agySettingsProvider 另补）。
 * 登录探测用实时清单；状态未知（启动后未探测、探测超时）用上次登录探测落盘的清单；
 * 明确未登录 / 未安装 / 版本过旧时不提供，存量会话引用的模型走现有「不可用模型」表现。
 */
export function offeredAgyModels(
  status: AgyAuthStatus,
  persisted: readonly AgyModelOption[]
): AgyModelOption[] {
  if (status.status === 'signed-in') return status.models;
  return status.status === 'unknown' ? [...persisted] : [];
}
