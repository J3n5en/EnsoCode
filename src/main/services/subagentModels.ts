import { isClassifierOnlyProvider } from '@shared/providerCatalog';
import type {
  ModelProvider,
  ModelReasoningOverride,
  ModelThinkingLevelOverride,
  SubagentModelEntry,
} from '@shared/types';
import {
  hasProviderCredentials,
  MODEL_REASONING_OVERRIDES,
  MODEL_THINKING_LEVEL_OVERRIDES,
} from '@shared/types';
import { isVirtualRef, type VirtualModelEntry } from '@shared/virtualModels';

export interface SubagentModelRef {
  /** 给 LLM 看的唯一键：物理 `{provider.name}/{modelId}`，虚拟为条目 name；冲突时追加 `#n` */
  name: string;
  providerId: string;
  modelId: string;
  /** 用户写的选型依据(空串不透传) */
  description?: string;
  /** 条目级推理覆盖(缺省 = 跟随父会话;非法值不透传) */
  reasoning?: ModelReasoningOverride;
  thinkingLevel?: ModelThinkingLevelOverride;
}

/**
 * 把设置页「允许子代理指定模型」列表解析成命名引用。
 * 条目需 `enabled !== false`。物理引用还要求 provider 存在、启用且有凭证、非分类器专用、模型行启用。
 * 虚拟引用只要求目录里存在且启用，不查凭证。禁用或缺失不占去重键。
 * 同一 provider+model 去重。凭证是否真能路由仍走 resolveModelSelection。
 */
export function pickSubagentModelRefs(
  entries: readonly SubagentModelEntry[],
  providers: readonly ModelProvider[],
  virtualModels: readonly VirtualModelEntry[]
): SubagentModelRef[] {
  const refs: SubagentModelRef[] = [];
  const named = new Map<string, number>();
  const seen = new Set<string>();
  for (const entry of entries) {
    if (!entry || typeof entry.providerId !== 'string' || typeof entry.modelId !== 'string') {
      continue;
    }
    if (entry.enabled === false) continue;
    const key = `${entry.providerId}\u0000${entry.modelId}`;
    if (seen.has(key)) continue;
    let base: string;
    let providerId: string;
    let modelId: string;
    if (isVirtualRef(entry)) {
      const virtual = virtualModels.find((item) => item.id === entry.modelId);
      if (!virtual?.enabled) continue;
      base = virtual.name;
      providerId = entry.providerId;
      modelId = virtual.id;
    } else {
      const provider = providers.find((candidate) => candidate.id === entry.providerId);
      if (!provider || provider.enabled === false || !hasProviderCredentials(provider)) continue;
      if (isClassifierOnlyProvider(provider)) continue;
      if (!Array.isArray(provider.models)) continue;
      const model = provider.models.find((candidate) => candidate?.id === entry.modelId);
      if (!model || model.enabled === false) continue;
      base = `${provider.name}/${model.id}`;
      providerId = provider.id;
      modelId = model.id;
    }
    seen.add(key);
    const count = (named.get(base) ?? 0) + 1;
    named.set(base, count);
    const description = typeof entry.description === 'string' ? entry.description.trim() : '';
    const reasoning = MODEL_REASONING_OVERRIDES.includes(entry.reasoning as ModelReasoningOverride)
      ? entry.reasoning
      : undefined;
    const thinkingLevel = MODEL_THINKING_LEVEL_OVERRIDES.includes(
      entry.thinkingLevel as ModelThinkingLevelOverride
    )
      ? entry.thinkingLevel
      : undefined;
    refs.push({
      name: count === 1 ? base : `${base}#${count}`,
      providerId,
      modelId,
      ...(description ? { description } : {}),
      ...(reasoning ? { reasoning } : {}),
      ...(thinkingLevel ? { thinkingLevel } : {}),
    });
  }
  return refs;
}
