/**
 * 标题总结的模型解析（Main 侧纯逻辑）。
 * settings.json 是用户机器上的真实文件，可能被手改坏——逐项收窄，坏条目跳过。
 */

import type { DefaultModelRef } from '@shared/defaultModel';

function asModelRef(value: unknown): DefaultModelRef | null {
  if (!value || typeof value !== 'object') return null;
  const { providerId, modelId } = value as { providerId?: unknown; modelId?: unknown };
  if (typeof providerId !== 'string' || providerId.length === 0) return null;
  if (typeof modelId !== 'string' || modelId.length === 0) return null;
  return { providerId, modelId };
}

/** 回退链：独立标题模型 → 全局默认模型（去重；均无 / 形状坏则为空 = 静默跳过） */
export function titleModelCandidates(
  state: Record<string, unknown> | undefined
): DefaultModelRef[] {
  if (!state) return [];
  const candidates: DefaultModelRef[] = [];
  for (const ref of [asModelRef(state.titleSummaryModel), asModelRef(state.defaultModel)]) {
    if (!ref) continue;
    if (candidates.some((c) => c.providerId === ref.providerId && c.modelId === ref.modelId)) {
      continue;
    }
    candidates.push(ref);
  }
  return candidates;
}
