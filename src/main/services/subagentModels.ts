import type { ModelProvider } from '@shared/types';
import { hasProviderCredentials } from '@shared/types';

export interface SubagentModelRef {
  /** 给 LLM 看的唯一键：`{provider.name}/{modelId}`,冲突时追加 `#n` */
  name: string;
  providerId: string;
  modelId: string;
}

/**
 * 从 settings providers 里挑出「模型中心勾选了子代理可用」的模型引用。
 * 过滤规则:provider 需启用且有凭证(API key 或订阅账号);模型行需
 * `enabled !== false && subagent === true`。凭证解析仍走 resolveModelSelection,
 * 这里只做纯过滤与命名,便于单测。
 */
export function pickSubagentModelRefs(providers: ModelProvider[]): SubagentModelRef[] {
  const refs: SubagentModelRef[] = [];
  const used = new Map<string, number>();
  for (const provider of providers) {
    if (provider.enabled === false || !hasProviderCredentials(provider)) continue;
    if (!Array.isArray(provider.models)) continue;
    for (const model of provider.models) {
      if (!model || typeof model.id !== 'string' || !model.id) continue;
      if (model.enabled === false || model.subagent !== true) continue;
      const base = `${provider.name}/${model.id}`;
      const count = (used.get(base) ?? 0) + 1;
      used.set(base, count);
      refs.push({
        name: count === 1 ? base : `${base}#${count}`,
        providerId: provider.id,
        modelId: model.id,
      });
    }
  }
  return refs;
}
