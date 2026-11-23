import { sessionEntryToContextMessages as upstream } from '@earendil-works/pi-coding-agent';
import { describe, expect, it } from 'vitest';
import { sessionEntryToContextMessages } from './sessionEntryMessages';

const base = { id: 'e1', parentId: null, timestamp: '2026-01-02T03:04:05.678Z' };
const entries: unknown[] = [
  { ...base, type: 'message', message: { role: 'user', content: [{ type: 'text', text: 'hi' }] } },
  { ...base, type: 'message', message: { role: 'user', content: null } },
  { ...base, type: 'message', message: { role: 'assistant' } },
  { ...base, type: 'message', message: { role: 'toolResult', toolCallId: 't', content: null } },
  { ...base, type: 'message', message: { role: 'system', content: null } },
  { ...base, type: 'message', message: { role: 'system', content: 'sys' } },
  { ...base, type: 'message', message: { role: 'bashExecution', command: 'ls', content: null } },
  { ...base, type: 'custom_message', customType: 'note', content: 'x', display: true },
  { ...base, type: 'custom_message', customType: 'note', display: false, details: { a: 1 } },
  { ...base, type: 'branch_summary', summary: 'went elsewhere', fromId: 'e0' },
  { ...base, type: 'branch_summary', summary: '', fromId: 'e0' },
  { ...base, type: 'compaction', summary: 's', tokensBefore: 10, firstKeptEntryId: 'e0' },
  {
    ...base,
    type: 'compaction',
    summary: 's',
    tokensBefore: 10,
    firstKeptEntryId: 'e0',
    systemMessage: { role: 'system', content: 'kept' },
  },
  { ...base, type: 'model_change', provider: 'p', modelId: 'm' },
  { ...base, type: 'custom', customType: 'state', data: {} },
  { ...base, type: 'label', targetId: 'e0', label: 'l' },
];

describe('sessionEntryToContextMessages 移植版', () => {
  it.each(entries.map((entry) => [(entry as { type: string }).type, entry]))(
    '%s 条目与 pi 原版输出一致',
    (_type, entry) => {
      const typed = entry as Parameters<typeof upstream>[0];
      expect(sessionEntryToContextMessages(typed)).toEqual(upstream(typed));
    }
  );
});
