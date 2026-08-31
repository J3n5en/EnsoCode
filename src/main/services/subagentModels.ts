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

export interface SubagentModelRef {
  /** 给 LLM 看的唯一键：`{provider.name}/{modelId}`,冲突时追加 `#n` */
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
 * 过滤规则:provider 需存在、启用且有凭证(API key 或订阅账号);
 * 模型行需存在且 `enabled !== false`;同一 provider+model 的重复条目去重。
 * 凭证解析仍走 resolveModelSelection,这里只做纯过滤与命名,便于单测。
 */
export function pickSubagentModelRefs(
  entries: readonly SubagentModelEntry[],
  providers: readonly ModelProvider[]
): SubagentModelRef[] {
  const refs: SubagentModelRef[] = [];
  const named = new Map<string, number>();
  const seen = new Set<string>();
  for (const entry of entries) {
    if (!entry || typeof entry.providerId !== 'string' || typeof entry.modelId !== 'string') {
      continue;
    }
    const key = `${entry.providerId}\u0000${entry.modelId}`;
    if (seen.has(key)) continue;
    const provider = providers.find((candidate) => candidate.id === entry.providerId);
    if (!provider || provider.enabled === false || !hasProviderCredentials(provider)) continue;
    if (!Array.isArray(provider.models)) continue;
    const model = provider.models.find((candidate) => candidate?.id === entry.modelId);
    if (!model || model.enabled === false) continue;
    seen.add(key);
    const base = `${provider.name}/${model.id}`;
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
      providerId: provider.id,
      modelId: model.id,
      ...(description ? { description } : {}),
      ...(reasoning ? { reasoning } : {}),
      ...(thinkingLevel ? { thinkingLevel } : {}),
    });
  }
  return refs;
}
