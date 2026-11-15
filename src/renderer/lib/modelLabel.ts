import type { ModelProvider, ModelRef } from '@shared/types';

/**
 * 模型引用 → 可读标签：找得到 provider 就写「Provider / model」，
 * 找不到（供应商被删或停用）退回 modelId，绝不显示空白。
 */
export function modelLabel(providers: readonly ModelProvider[], ref: ModelRef | undefined): string {
  if (!ref) return '';
  const provider = providers.find((entry) => entry.id === ref.providerId);
  return provider ? `${provider.name} / ${ref.modelId}` : ref.modelId;
}
