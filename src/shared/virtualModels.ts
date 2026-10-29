import type { DefaultModelRef } from './defaultModel';
import { DEFAULT_BASE_URLS, isClassifierOnlyProvider } from './providerCatalog';
import type { ModelProvider } from './types/llm';
import { providerIdOfAccountKey } from './types/oauthProviders';

/** 虚拟模型引用的 providerId；modelId 是条目 id。所有 DefaultModelRef 存储位形状不变。 */
export const VIRTUAL_PROVIDER_ID = 'enso-virtual';

export const VIRTUAL_CLASSIFIER_SOURCES = ['judge', 'pi-classifier'] as const;
export type VirtualClassifierSource = (typeof VIRTUAL_CLASSIFIER_SOURCES)[number];
export const VIRTUAL_CLASSIFIER_DEFAULT_TIMEOUT_MS = 3000;
export const CLASSIFIER_TIMEOUT_MIN_MS = 500;
export const CLASSIFIER_TIMEOUT_MAX_MS = 30_000;

export const clampClassifierTimeoutMs = (ms: number): number =>
  Math.min(CLASSIFIER_TIMEOUT_MAX_MS, Math.max(CLASSIFIER_TIMEOUT_MIN_MS, Math.round(ms)));

export interface VirtualClassifierConfig {
  source: VirtualClassifierSource;
  /** judge：快聊天模型；pi-classifier：分类器所在 provider 条目 + 分类器模型 id */
  model: DefaultModelRef;
  timeoutMs: number;
  /** 用户在设置页明确填过时限；缺省表示 timeoutMs 只是旧版写下的默认快照 */
  timeoutSet?: true;
}

export interface VirtualModelEntry {
  id: string;
  name: string;
  enabled: boolean;
  /** 默认成员（强模型） */
  primary: DefaultModelRef;
  /** 快/便宜成员：direct 请求、分类为简单时使用 */
  fast?: DefaultModelRef;
  /** 故障转移顺序 */
  fallbacks: DefaultModelRef[];
  classifier?: VirtualClassifierConfig;
}

const NAME_MAX = 60;
const FALLBACKS_MAX = 8;

export function isVirtualRef(ref: { providerId?: string | null } | null | undefined): boolean {
  return ref?.providerId === VIRTUAL_PROVIDER_ID;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

function parseRef(value: unknown): DefaultModelRef | null {
  if (!isRecord(value)) return null;
  const { providerId, modelId } = value;
  if (typeof providerId !== 'string' || !providerId.trim()) return null;
  if (typeof modelId !== 'string' || !modelId.trim()) return null;
  return { providerId, modelId };
}

/** 成员必须是真实模型：不嵌套虚拟模型。 */
function parseMemberRef(value: unknown): DefaultModelRef | null {
  const ref = parseRef(value);
  return ref && !isVirtualRef(ref) ? ref : null;
}

export const sameModelRef = (a: DefaultModelRef, b: DefaultModelRef): boolean =>
  a.providerId === b.providerId && a.modelId === b.modelId;

export function parseVirtualClassifier(value: unknown): VirtualClassifierConfig | undefined {
  if (!isRecord(value)) return undefined;
  const source = value.source;
  if (!VIRTUAL_CLASSIFIER_SOURCES.includes(source as VirtualClassifierSource)) return undefined;
  const model = parseMemberRef(value.model);
  if (!model) return undefined;
  const timeoutMs = clampClassifierTimeoutMs(
    typeof value.timeoutMs === 'number' && Number.isFinite(value.timeoutMs)
      ? value.timeoutMs
      : VIRTUAL_CLASSIFIER_DEFAULT_TIMEOUT_MS
  );
  return {
    source: source as VirtualClassifierSource,
    model,
    timeoutMs,
    ...(value.timeoutSet === true && { timeoutSet: true as const }),
  };
}

function parseEntry(value: unknown): VirtualModelEntry | null {
  if (!isRecord(value)) return null;
  if (typeof value.id !== 'string' || !value.id.trim()) return null;
  // 名称清空只是编辑中间态：给默认名，不能因此丢掉整条（会话还引用着它）
  const name =
    (typeof value.name === 'string' ? value.name.trim().slice(0, NAME_MAX) : '') || 'Auto';
  const primary = parseMemberRef(value.primary);
  if (!primary) return null;
  const fast = parseMemberRef(value.fast) ?? undefined;
  const fallbacks: DefaultModelRef[] = [];
  for (const item of Array.isArray(value.fallbacks) ? value.fallbacks : []) {
    const ref = parseMemberRef(item);
    if (!ref || sameModelRef(ref, primary) || fallbacks.some((kept) => sameModelRef(kept, ref)))
      continue;
    if (fallbacks.length >= FALLBACKS_MAX) break;
    fallbacks.push(ref);
  }
  const classifier = parseVirtualClassifier(value.classifier);
  return {
    id: value.id,
    name,
    enabled: value.enabled !== false,
    primary,
    ...(fast && !sameModelRef(fast, primary) ? { fast } : {}),
    fallbacks,
    ...(classifier ? { classifier } : {}),
  };
}

/** 持久化数据可能被手改：非法条目丢弃，重复 id 保留第一条。 */
export function parseVirtualModels(value: unknown): VirtualModelEntry[] {
  if (!Array.isArray(value)) return [];
  const entries: VirtualModelEntry[] = [];
  for (const item of value) {
    const entry = parseEntry(item);
    if (entry && !entries.some((kept) => kept.id === entry.id)) entries.push(entry);
  }
  return entries;
}

export function findVirtualModel(
  virtualModels: readonly VirtualModelEntry[] | undefined,
  ref: { providerId?: string | null; modelId?: string | null } | null | undefined
): VirtualModelEntry | undefined {
  if (!ref || !isVirtualRef(ref)) return undefined;
  return virtualModels?.find((entry) => entry.id === ref.modelId);
}

/** 不走路由的辅助场景（标题、代审、btw…）落到虚拟引用时用的真实成员。 */
export function directMemberRef(entry: VirtualModelEntry): DefaultModelRef {
  return entry.fast ?? entry.primary;
}

/** Cursor 走 sessionBridge 直调工具，不经 pi 请求管线，不能做成员。 */
export function canBeVirtualMember(
  provider: Partial<Pick<ModelProvider, 'oauthAccountKey' | 'api' | 'baseUrl' | 'catalogId'>>
): boolean {
  return (
    !isClassifierOnlyProvider(provider) &&
    (!provider.oauthAccountKey || providerIdOfAccountKey(provider.oauthAccountKey) !== 'cursor')
  );
}

/** 界面显示用：虚拟模型 id 显示为其名称，其余原样 */
export function modelDisplayName(
  virtualModels: readonly VirtualModelEntry[] | undefined,
  modelId: string
): string {
  return virtualModels?.find((entry) => entry.id === modelId)?.name ?? modelId;
}

/** pi 内置里提供分类器（System One 协议）的 provider，及其 API 域名 */
const CLASSIFIER_PROVIDER_HOSTS: Readonly<Record<string, string>> = {
  'openrouter.ai': 'openrouter',
  'opencode.ai': 'opencode',
  'ai-gateway.vercel.sh': 'vercel-ai-gateway',
  'api.typesafe.ai': 'typesafe',
};
const CLASSIFIER_PROVIDER_IDS = new Set(Object.values(CLASSIFIER_PROVIDER_HOSTS));

/**
 * 设置里的 provider 条目能否当 pi 分类器的凭证来源，能则返回 pi provider id。
 * 订阅账号返回账号 key（多账号克隆同样按 key 取凭证）；显式 System One 协议的条目不限域名；
 * 其余 API key 条目按 baseUrl 域名识别。
 */
function systemOneBaseUrl(baseUrl: string): URL | undefined {
  try {
    const url = new URL(baseUrl.trim() || DEFAULT_BASE_URLS['typesafe-system-one']);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url : undefined;
  } catch {
    return undefined;
  }
}

/**
 * 显式声明 System One 协议、地址不是官方域名的条目（兼容网关），分类请求改打它自己的地址；
 * 官方或未填地址返回 undefined，沿用 pi 内置地址。
 */
export function classifierBaseUrlFor(
  provider: Pick<ModelProvider, 'baseUrl'> & Partial<Pick<ModelProvider, 'api' | 'oauthAccountKey'>>
): string | undefined {
  if (provider.oauthAccountKey || provider.api !== 'typesafe-system-one') return undefined;
  if (!provider.baseUrl.trim()) return undefined;
  const url = systemOneBaseUrl(provider.baseUrl);
  if (!url) return undefined;
  const host = url.hostname.toLowerCase();
  if (host === 'api.typesafe.ai' || host.endsWith('.api.typesafe.ai')) return undefined;
  return provider.baseUrl.trim().replace(/\/+$/, '');
}

export function classifierProviderFor(
  provider: Pick<ModelProvider, 'oauthAccountKey' | 'baseUrl' | 'catalogId'> &
    Partial<Pick<ModelProvider, 'api'>>
): string | undefined {
  if (provider.oauthAccountKey) {
    return CLASSIFIER_PROVIDER_IDS.has(providerIdOfAccountKey(provider.oauthAccountKey))
      ? provider.oauthAccountKey
      : undefined;
  }
  if (provider.api === 'typesafe-system-one') {
    return systemOneBaseUrl(provider.baseUrl)
      ? CLASSIFIER_PROVIDER_HOSTS['api.typesafe.ai']
      : undefined;
  }
  // 只认 baseUrl 域名：目录 id 相同但 baseUrl 改成中转站时，不能把 key 发到官方域名
  try {
    const host = new URL(provider.baseUrl.trim()).hostname.toLowerCase();
    for (const [domain, id] of Object.entries(CLASSIFIER_PROVIDER_HOSTS)) {
      if (host === domain || host.endsWith(`.${domain}`)) return id;
    }
  } catch {
    // 非法 baseUrl：不是分类器来源
  }
  return undefined;
}
