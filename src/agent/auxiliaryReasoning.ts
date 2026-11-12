import type { ThinkingLevel } from '@shared/types/agent';
import type { ModelCapabilityOverrides } from '@shared/types/llm';

/**
 * 辅助调用（标题总结、工具批次标签、记忆蒸馏）没有会话档位，pi 缺省按 off 发送。
 * Responses 协议下 off 会序列化成 `reasoning: { effort: "none" }`，而明确要求推理的模型
 * 收到 none 会先回 200 再中途断流（真机表现：other side closed / UND_ERR_SOCKET）。
 * 所以模型配了「推理开启」时，辅助调用必须带上档位。
 */
export function auxiliaryReasoning(
  candidate: ModelCapabilityOverrides | undefined,
  fallback: ThinkingLevel = 'medium'
): ThinkingLevel | undefined {
  if (candidate?.reasoning !== 'on') return undefined;
  return candidate.thinkingLevel ?? fallback;
}
