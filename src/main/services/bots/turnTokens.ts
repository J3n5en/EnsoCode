import type { ProjectedMessage } from '../../../shared/types/agent';

const CJK = /[\u2e80-\u9fff\uac00-\ud7af\uf900-\ufaff\uff00-\uffef]/gu;

/** 中日韩约 1.5 字/token，其余约 4 字符/token */
export function estimateTextTokens(text: string): number {
  const cjk = text.match(CJK)?.length ?? 0;
  return Math.ceil(cjk / 1.5 + (text.length - cjk) / 4);
}

/**
 * 一条 assistant 消息的 token（tokens）与其中厂商实报的部分（real）。
 * 结束且有实报用量时取实报；否则 OpenAI 兼容流式中不报 input、末尾才报 output：
 * 输入取会话最近的上下文占用 contextTokens，输出按已流出的正文 / 推理 / 工具参数估算。
 */
export function messageTokens(
  message: ProjectedMessage,
  final: boolean,
  contextTokens = 0
): { tokens: number; real: number } {
  const usage = message.usage;
  const input = usage ? usage.input + usage.cacheRead + usage.cacheWrite : 0;
  const output = usage?.output ?? 0;
  if (final && input + output > 0) return { tokens: input + output, real: input + output };
  let text = '';
  for (const part of message.content) {
    if (part.type === 'text' || part.type === 'thinking') text += part.text;
    else if (part.type === 'toolCall') text += JSON.stringify(part.arguments ?? '');
  }
  return {
    tokens: (input > 0 ? input : contextTokens) + Math.max(output, estimateTextTokens(text)),
    real: input + output,
  };
}
