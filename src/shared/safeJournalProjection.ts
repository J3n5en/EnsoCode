import type { AgentSessionCustomEntry, ProjectedMessage, SafeJournalRecord } from './types/agent';

export interface SafeJournalTimeline {
  messages: ProjectedMessage[];
  customEntries: AgentSessionCustomEntry[];
}

/**
 * 把已结束 child 的 safe journal 投影成渲染层时间线。
 *
 * 纯函数、无 IO：Main 读盘拿到 records 后调用，渲染层直接消费结果。
 * 这是只读回放，不复活会话，也不携带任何可执行权限。
 *
 * `enso-operation` 与 `safe-model-result` 刻意丢弃：前者是内部关联用的 id，
 * 后者的结论已经体现在 receipt 与助手回复里，重复展示只会让时间线更吵。
 */
export function projectSafeJournal(records: readonly SafeJournalRecord[]): SafeJournalTimeline {
  const messages: ProjectedMessage[] = [];
  const customEntries: AgentSessionCustomEntry[] = [];

  for (const record of records) {
    switch (record.type) {
      case 'safe-user-text':
        messages.push({
          role: 'user',
          content: [{ type: 'text', text: record.text }],
          timestamp: record.at,
        });
        break;
      case 'safe-assistant-text':
        messages.push({
          role: 'assistant',
          content: [{ type: 'text', text: record.text }],
          timestamp: record.at,
        });
        break;
      case 'capability-receipt':
        customEntries.push({ kind: 'capability-receipt', receipt: record.receipt });
        break;
      default:
        break;
    }
  }

  return { messages, customEntries };
}
