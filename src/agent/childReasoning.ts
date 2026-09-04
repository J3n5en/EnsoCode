import type { ThinkingLevel } from '@shared/types/agent';
import { THINKING_LEVELS } from '@shared/types/agent';
import type { ModelReasoningOverride, ModelThinkingLevelOverride } from '@shared/types/llm';

export interface ChildReasoningOverride {
  reasoning?: ModelReasoningOverride;
  thinkingLevel?: ModelThinkingLevelOverride;
}

/** 对齐 pi `/thinking`：off 关闭推理，其余为努力档。 */
export const CHILD_THINKING_LEVELS = ['off', ...THINKING_LEVELS] as const;
export type ChildThinkingLevel = (typeof CHILD_THINKING_LEVELS)[number];

export function isChildThinkingLevel(value: string): value is ChildThinkingLevel {
  return (CHILD_THINKING_LEVELS as readonly string[]).includes(value);
}

/**
 * 解析 `provider/model:high` 这种 pi 思考后缀。非法后缀原样当模型名，避免误切。
 */
export function parseModelThinkingRef(raw: string): {
  name: string;
  thinking?: ChildThinkingLevel;
} {
  const trimmed = raw.trim();
  const colon = trimmed.lastIndexOf(':');
  if (colon <= 0) return { name: trimmed };
  const suffix = trimmed.slice(colon + 1).toLowerCase();
  if (!isChildThinkingLevel(suffix)) return { name: trimmed };
  const name = trimmed.slice(0, colon).trim();
  if (!name) return { name: trimmed };
  return { name, thinking: suffix };
}

export function thinkingToOverride(thinking: ChildThinkingLevel): ChildReasoningOverride {
  if (thinking === 'off') return { reasoning: 'off' };
  return { reasoning: 'on', thinkingLevel: thinking };
}

/**
 * 子会话推理决策：派发 thinking / 条目级覆盖赢过父会话；
 * 缺省 = 跟随父。关闭时档位恒为 'off'（pi 不发 thinking）。
 */
export function resolveChildReasoning(
  override: ChildReasoningOverride | undefined,
  parentEnabled: boolean,
  parentLevel?: ThinkingLevel
): { enabled: boolean; level: ThinkingLevel | 'off' } {
  const enabled = override?.reasoning ? override.reasoning === 'on' : parentEnabled;
  return {
    enabled,
    level: enabled ? (override?.thinkingLevel ?? parentLevel ?? 'medium') : 'off',
  };
}
