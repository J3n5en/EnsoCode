import type { ThinkingLevel } from '@shared/types/agent';
import type { ModelReasoningOverride, ModelThinkingLevelOverride } from '@shared/types/llm';

export interface ChildReasoningOverride {
  reasoning?: ModelReasoningOverride;
  thinkingLevel?: ModelThinkingLevelOverride;
}

/**
 * 子会话推理决策：条目级覆盖（subagent-models）赢过父会话；
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
