import type { ProjectedMessage } from '@shared/types/agent';

export type TimelineItem =
  | { kind: 'user'; key: string; text: string; images: { data: string; mimeType: string }[] }
  | { kind: 'text'; key: string; text: string; streaming: boolean }
  | { kind: 'thinking'; key: string; text: string; streaming: boolean }
  | {
      kind: 'tool';
      key: string;
      name: string;
      summary: string;
      output: string | null;
      state: 'running' | 'ok' | 'error';
    }
  | { kind: 'error'; key: string; text: string };

/** 从工具参数里挑一个最能说明「对什么操作」的字段做摘要 */
const SUMMARY_KEYS = ['path', 'file_path', 'command', 'pattern', 'query', 'url', 'description'];

function summarizeArgs(args: unknown): string {
  if (!args || typeof args !== 'object') return '';
  const record = args as Record<string, unknown>;
  for (const key of SUMMARY_KEYS) {
    const value = record[key];
    if (typeof value === 'string' && value) return value;
  }
  const json = JSON.stringify(record);
  return json === '{}' ? '' : json.slice(0, 80);
}

const partText = (message: ProjectedMessage): string =>
  message.content.map((part) => (part.type === 'text' ? part.text : '')).join('');

/**
 * 把消息投影聚合为渲染时间线：
 * - toolResult 不单独成行，折进对应 toolCall 条目（按 toolCallId 关联）
 * - assistant 的 text/thinking 各自成块，未完结（isLast 且会话 running）的块标 streaming
 * 纯函数，输入不被修改。
 */
export function buildTimeline(messages: ProjectedMessage[], running: boolean): TimelineItem[] {
  const results = new Map<string, { output: string; isError: boolean }>();
  for (const message of messages) {
    if (message.role === 'toolResult' && message.toolCallId) {
      results.set(message.toolCallId, {
        output: partText(message),
        isError: message.isError === true,
      });
    }
  }

  const items: TimelineItem[] = [];
  messages.forEach((message, messageIndex) => {
    const isLastMessage = messageIndex === messages.length - 1;
    if (message.role === 'user') {
      const text = partText(message);
      const images = message.content.filter((part) => part.type === 'image');
      if (text || images.length > 0) {
        items.push({ kind: 'user', key: `${messageIndex}`, text, images });
      }
      return;
    }
    if (message.role === 'toolResult') return;
    if (message.role !== 'assistant') return;

    message.content.forEach((part, partIndex) => {
      const key = `${messageIndex}-${partIndex}`;
      const isLastPart = isLastMessage && partIndex === message.content.length - 1;
      const streaming = running && isLastPart && !message.stopReason;
      switch (part.type) {
        case 'text':
          if (part.text) items.push({ kind: 'text', key, text: part.text, streaming });
          return;
        case 'thinking':
          if (part.text) items.push({ kind: 'thinking', key, text: part.text, streaming });
          return;
        case 'toolCall': {
          const result = results.get(part.id);
          items.push({
            kind: 'tool',
            key,
            name: part.name,
            summary: summarizeArgs(part.arguments),
            output: result ? result.output : null,
            state: result ? (result.isError ? 'error' : 'ok') : running ? 'running' : 'ok',
          });
          return;
        }
        default:
          return;
      }
    });
    if (message.errorMessage) {
      items.push({ kind: 'error', key: `${messageIndex}-err`, text: message.errorMessage });
    }
  });
  return items;
}
