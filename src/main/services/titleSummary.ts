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

/** 回退链：独立标题模型 → 全局默认 → 当前会话模型（去重；全空则静默跳过）。
 * 会话模型来自渲染层（不可信），同样走收窄；很多用户从不设全局默认，只在会话里选模，
 * 没有这一级兑底功能对他们永远不生效。 */
export function titleModelCandidates(
  state: Record<string, unknown> | undefined,
  sessionModel?: DefaultModelRef
): DefaultModelRef[] {
  const candidates: DefaultModelRef[] = [];
  for (const ref of [
    asModelRef(state?.titleSummaryModel),
    asModelRef(state?.defaultModel),
    asModelRef(sessionModel),
  ]) {
    if (!ref) continue;
    if (candidates.some((c) => c.providerId === ref.providerId && c.modelId === ref.modelId)) {
      continue;
    }
    candidates.push(ref);
  }
  return candidates;
}
