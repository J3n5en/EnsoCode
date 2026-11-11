import type { InlineExtension } from '@earendil-works/pi-coding-agent';

/**
 * 输出撞上模型输出上限后的恢复（借鉴 qwen-code adaptive-output-token-escalation 的续写层）。
 * pi 默认就按模型上限请求、输出被上下文挤压时自己压缩重试、截断回复里的工具调用一律拒绝执行；
 * 这里只补两处：纯文本截断时保留半截并让模型接着写，工具调用被拒时告诉它拆小，别原样重发。
 */
export const OUTPUT_LIMIT_RECOVERY_ATTEMPTS = 3;
export const OUTPUT_LIMIT_RESUME =
  'Output token limit hit. Resume directly — no apology, no recap of what you were doing. ' +
  'Pick up mid-thought if that is where the cut happened. Break remaining work into smaller pieces.';
export const OUTPUT_LIMIT_SPLIT =
  'Your previous response hit the output token limit, so its tool calls were not executed. ' +
  'Do NOT re-issue the same large call: split the content — write a skeleton or the first part, ' +
  'then add the remaining sections with incremental edits.';
const CUSTOM_TYPE = 'output-limit-recovery';

export function outputLimitRecovery(input: {
  outcome: string;
  stopReason: string | undefined;
  outputTokens: number | undefined;
  modelMaxTokens: number | undefined;
  toolResultCount: number;
  attempts: number;
}): 'resume' | 'split' | undefined {
  if (input.outcome !== 'completed' || input.stopReason !== 'length') return undefined;
  if (input.attempts >= OUTPUT_LIMIT_RECOVERY_ATTEMPTS) return undefined;
  if (
    input.modelMaxTokens !== undefined &&
    input.outputTokens !== undefined &&
    input.outputTokens < input.modelMaxTokens
  )
    return undefined;
  return input.toolResultCount > 0 ? 'split' : 'resume';
}

export const outputLimitRecoveryExtension: InlineExtension = {
  name: 'output-limit-recovery',
  hidden: true,
  factory: (pi) => {
    let attempts = 0;
    pi.on('agent_start', () => {
      attempts = 0;
    });
    pi.on('turn_end', (event, ctx) => {
      const message = event.message as { stopReason?: string; usage?: { output?: number } };
      const action = outputLimitRecovery({
        outcome: event.outcome,
        stopReason: message.stopReason,
        outputTokens: message.usage?.output,
        modelMaxTokens: ctx.model?.maxTokens,
        toolResultCount: event.toolResults.length,
        attempts,
      });
      if (!action) return;
      attempts++;
      const entries = [
        ...event.entries,
        {
          type: 'custom_message' as const,
          customType: CUSTOM_TYPE,
          content: action === 'resume' ? OUTPUT_LIMIT_RESUME : OUTPUT_LIMIT_SPLIT,
          display: false,
        },
      ];
      return action === 'resume' ? { entries, continue: true } : { entries };
    });
  },
};
