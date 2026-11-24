import type { ModelProvider, ModelRef } from '@shared/types';
import { isVirtualRef, modelDisplayName, type VirtualModelEntry } from '@shared/virtualModels';

/**
 * 模型引用 → 可读标签：找得到 provider 就写「Provider / model」，
 * 找不到（供应商被删或停用）退回 modelId，绝不显示空白；虚拟模型显示其名称。
 */
export function modelLabel(
  providers: readonly ModelProvider[],
  ref: ModelRef | undefined,
  virtualModels?: readonly VirtualModelEntry[]
): string {
  if (!ref) return '';
  if (isVirtualRef(ref)) return modelDisplayName(virtualModels, ref.modelId);
  const provider = providers.find((entry) => entry.id === ref.providerId);
  return provider ? `${provider.name} / ${ref.modelId}` : ref.modelId;
}
