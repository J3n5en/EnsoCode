import { clampProjectThinkingLevel, supportedProjectThinkingLevels } from '@shared/modelThinking';
import type { ThinkingLevel } from '@shared/types/agent';
import { THINKING_LEVELS } from '@shared/types/agentConstants';
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

/** 统一解析子会话的模型名与思考档；显式 thinking 优先于模型后缀。 */
export function resolveChildThinkingInput(
  modelName?: string,
  thinkingRaw?: string
): { modelName?: string; thinking?: ChildThinkingLevel } {
  const parsed = parseModelThinkingRef(modelName ?? '');
  let thinking = parsed.thinking;
  if (thinkingRaw) {
    if (!isChildThinkingLevel(thinkingRaw)) {
      throw new Error(
        `unknown thinking "${thinkingRaw}". Available: [${CHILD_THINKING_LEVELS.join(', ')}] or omit to inherit.`
      );
    }
    thinking = thinkingRaw;
  }
  return { modelName: parsed.name || undefined, thinking };
}

export function thinkingToOverride(thinking: ChildThinkingLevel): ChildReasoningOverride {
  if (thinking === 'off') return { reasoning: 'off' };
  return { reasoning: 'on', thinkingLevel: thinking };
}

/**
 * 合并子会话显式推理覆盖：派发 thinking > 类型预设。父会话与模型条目预设由 resolveChildReasoning 兜底。
 */
export function pickChildReasoningOverride(
  dispatched: ChildThinkingLevel | undefined,
  agentTypeOverride: ChildReasoningOverride | undefined
): ChildReasoningOverride {
  if (dispatched) return thinkingToOverride(dispatched);
  const reasoning = agentTypeOverride?.reasoning;
  const thinkingLevel = agentTypeOverride?.thinkingLevel;
  return {
    ...(reasoning ? { reasoning } : {}),
    ...(thinkingLevel ? { thinkingLevel } : {}),
  };
}

/**
 * 子会话推理决策：显式覆盖（派发/类型预设）> 父会话当前选择 > 模型条目预设 > medium。
 * 父会话开启推理即视为给了值，模型条目只在父关闭或无档位时兜底。关闭时档位恒为 'off'（pi 不发 thinking）。
 */
export function resolveChildReasoning(
  override: ChildReasoningOverride | undefined,
  parentEnabled: boolean,
  parentLevel?: ThinkingLevel,
  modelOverride?: ChildReasoningOverride
): { enabled: boolean; level: ThinkingLevel | 'off' } {
  const enabled = override?.reasoning
    ? override.reasoning === 'on'
    : parentEnabled || modelOverride?.reasoning === 'on';
  if (!enabled) return { enabled, level: 'off' };
  return {
    enabled,
    level:
      override?.thinkingLevel ??
      (parentEnabled ? parentLevel : undefined) ??
      modelOverride?.thinkingLevel ??
      'medium',
  };
}

/**
 * 把子会话推理决策收进模型实际能力：
 * 模型明确不支持思考时关掉，不把档位强行打开（否则上游会拒请求）；
 * 声明了档位表时越界档按 pi 的方向钳位。没有档位表则原样交给 pi。
 */
export function fitChildReasoningToModel(
  decision: { enabled: boolean; level: ThinkingLevel | 'off' },
  model: {
    reasoning?: boolean;
    thinkingLevelMap?: Record<string, string | null | undefined>;
  }
): { enabled: boolean; level: ThinkingLevel | 'off' } {
  if (!decision.enabled || decision.level === 'off' || model.reasoning === false) {
    return { enabled: false, level: 'off' };
  }
  if (!model.thinkingLevelMap) return decision;
  const supported = supportedProjectThinkingLevels({
    reasoning: true,
    thinkingLevelMap: model.thinkingLevelMap,
  });
  return { enabled: true, level: clampProjectThinkingLevel(decision.level, supported) };
}
