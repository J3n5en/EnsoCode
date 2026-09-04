import type { ModelProvider } from './types/llm';
import { providerIdOfAccountKey } from './types/oauthProviders';

/**
 * 供应商（厂商）归组。把两类条目归一到**同一个 vendor id 命名域**——用 pi 基础 providerId
 * 的命名，这样 `anthropic` 的订阅条目与 `api.anthropic.com` 的 API-key 条目会自然同组。
 *
 * ⛔ 明确不用作归组键：`provider.api`（协议不是厂商，多厂商共用 openai-completions）、
 * `provider.importedFrom`（来源应用不是厂商）、`provider.name`（用户可改）。
 * 这三个继续只做行内 Badge。
 */

/** 识别不出厂商的 API-key 条目落这一组，排序上恒定最后 */
export const CUSTOM_VENDOR_ID = '__custom';

/** 精确 hostname → vendorId。⚠️ 纯展示层归组表，不参与请求路由；缺项只影响分组 */
const VENDOR_BY_HOST: Readonly<Record<string, string>> = {
  'api.anthropic.com': 'anthropic',
  'api.openai.com': 'openai',
  'generativelanguage.googleapis.com': 'google',
  'api.deepseek.com': 'deepseek',
  'api.x.ai': 'xai',
  'openrouter.ai': 'openrouter',
  'api.moonshot.cn': 'moonshot',
  'api.moonshot.ai': 'moonshot',
  'open.bigmodel.cn': 'zhipu',
  'api.minimax.chat': 'minimax',
  'api.siliconflow.cn': 'siliconflow',
  'api.groq.com': 'groq',
  'api.mistral.ai': 'mistral',
  localhost: 'local',
  '127.0.0.1': 'local',
  // WHATWG hostname 对 IPv6 带方括号；::1 与 127.0.0.1 同属 loopback
  '[::1]': 'local',
};

/** 后缀表，处理子域形态（顺序无关：命中即返回，键互不为前缀） */
const VENDOR_BY_HOST_SUFFIX: readonly (readonly [string, string])[] = [
  ['.openai.azure.com', 'azure-openai'],
  ['.aliyuncs.com', 'alibaba'],
  ['.volces.com', 'volcengine'],
];

/** 无订阅条目可借名时的静态展示名兜底 */
const VENDOR_LABELS: Readonly<Record<string, string>> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  google: 'Google',
  deepseek: 'DeepSeek',
  xai: 'xAI',
  openrouter: 'OpenRouter',
  moonshot: 'Moonshot',
  zhipu: 'Zhipu AI',
  minimax: 'MiniMax',
  siliconflow: 'SiliconFlow',
  groq: 'Groq',
  mistral: 'Mistral AI',
  local: 'Local',
  'azure-openai': 'Azure OpenAI',
  alibaba: 'Alibaba Cloud',
  volcengine: 'Volcengine',
};

/**
 * 顺序：订阅账号 → 向导 catalogId（含 `__custom`）→ baseUrl hostname 查表 → `__custom`。
 * baseUrl 为空或非法（new URL 抛异常）同样落 `__custom`，不向外抛。
 */
export function vendorOf(
  provider: Pick<ModelProvider, 'oauthAccountKey' | 'baseUrl' | 'catalogId'>
): string {
  if (provider.oauthAccountKey) return providerIdOfAccountKey(provider.oauthAccountKey);
  // 向导选择优先于 hostname：Custom 即使填了官方 URL 也要单独成组。
  if (provider.catalogId) return provider.catalogId;

  let host: string;
  try {
    host = new URL(provider.baseUrl).hostname.toLowerCase();
  } catch {
    return CUSTOM_VENDOR_ID;
  }
  if (host.startsWith('www.')) host = host.slice(4);

  const exact = VENDOR_BY_HOST[host];
  if (exact) return exact;
  for (const [suffix, vendor] of VENDOR_BY_HOST_SUFFIX) {
    if (host.endsWith(suffix)) return vendor;
  }
  return CUSTOM_VENDOR_ID;
}

/**
 * 展示名：优先借订阅 provider 的官方名（`providers.listOauth()` 的 `name`），
 * 其次静态表，其次 vendorId 原样。`__custom` 交由调用方用 `t('Custom')` 本地化——
 * shared 层不引入 i18n 依赖。
 */
export function vendorLabel(
  vendorId: string,
  oauthInfos?: readonly { id: string; name: string }[]
): string {
  if (vendorId === CUSTOM_VENDOR_ID) return '';
  const official = oauthInfos?.find((info) => info.id === vendorId)?.name;
  return official || VENDOR_LABELS[vendorId] || vendorId;
}

export interface ProviderGroup {
  vendorId: string;
  /** `__custom` 组为空串，调用方替换为本地化的「自定义」 */
  label: string;
  providers: ModelProvider[];
}

/**
 * 分组 + 全确定性排序：
 * - 组间：非 `__custom` 按 label 的 localeCompare 升序；`__custom` 恒最后
 * - 组内：先订阅条目（按 oauthAccountKey 字典序，天然让裸 `anthropic` 排在 `anthropic#2` 前），
 *   再 API-key 条目（保持入参数组原序，即用户/导入顺序，稳定）
 */
export function groupProviders(
  providers: readonly ModelProvider[],
  oauthInfos?: readonly { id: string; name: string }[]
): ProviderGroup[] {
  const byVendor = new Map<string, ModelProvider[]>();
  for (const provider of providers) {
    const vendorId = vendorOf(provider);
    const bucket = byVendor.get(vendorId);
    if (bucket) bucket.push(provider);
    else byVendor.set(vendorId, [provider]);
  }

  const groups: ProviderGroup[] = [];
  for (const [vendorId, bucket] of byVendor) {
    const subscriptions = bucket
      .filter((provider) => provider.oauthAccountKey)
      .sort((a, b) => (a.oauthAccountKey ?? '').localeCompare(b.oauthAccountKey ?? ''));
    const apiKeys = bucket.filter((provider) => !provider.oauthAccountKey);
    groups.push({
      vendorId,
      label: vendorLabel(vendorId, oauthInfos),
      providers: [...subscriptions, ...apiKeys],
    });
  }

  return groups.sort((a, b) => {
    if (a.vendorId === CUSTOM_VENDOR_ID) return 1;
    if (b.vendorId === CUSTOM_VENDOR_ID) return -1;
    return a.label.localeCompare(b.label);
  });
}
