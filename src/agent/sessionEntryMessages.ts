import type { AgentMessage } from '@earendil-works/pi-agent-core';
import type { SessionEntry } from '@earendil-works/pi-coding-agent';

/**
 * pi `sessionEntryToContextMessages` 的等价移植：Main 与 transcript 只要这一个纯函数，
 * 静态 import pi-coding-agent 会让主进程启动与上百个测试各多加载一遍整个包。
 * 与 pi 原版逐项比对的测试见 sessionEntryMessages.test.ts，升级 pi 时它会先报。
 */
export function sessionEntryToContextMessages(entry: SessionEntry): AgentMessage[] {
  if (entry.type === 'message') {
    const message = entry.message;
    if (message.role === 'system' && message.content == null) return [{ ...message, content: '' }];
    if (
      (message.role === 'user' || message.role === 'assistant' || message.role === 'toolResult') &&
      message.content == null
    ) {
      return [{ ...message, content: [] }];
    }
    return [message];
  }
  if (entry.type === 'custom_message') {
    return [
      {
        role: 'custom',
        customType: entry.customType,
        content: entry.content ?? [],
        display: entry.display,
        details: entry.details,
        timestamp: new Date(entry.timestamp).getTime(),
      },
    ];
  }
  if (entry.type === 'branch_summary' && entry.summary) {
    return [
      {
        role: 'branchSummary',
        summary: entry.summary,
        fromId: entry.fromId,
        timestamp: new Date(entry.timestamp).getTime(),
      },
    ];
  }
  if (entry.type === 'compaction') {
    const summary: AgentMessage = {
      role: 'compactionSummary',
      summary: entry.summary,
      tokensBefore: entry.tokensBefore,
      timestamp: new Date(entry.timestamp).getTime(),
    };
    return entry.systemMessage ? [entry.systemMessage, summary] : [summary];
  }
  return [];
}
