import { describe, expect, it } from 'vitest';
import type { CapabilityReceipt } from './capabilities/types';
import { projectSafeJournal } from './safeJournalProjection';
import type { SafeJournalRecord } from './types/agent';

const receipt = {
  receiptId: 'r1',
  operationId: 'op-1',
  child: {
    sessionId: 'parent::cw-1',
    generation: 'gen-1',
    parent: { sessionId: 'parent', generation: 'pgen-1' },
    instanceId: 'inst-1',
    instanceName: 'Enso-1',
    typeKey: 'agent:enso',
    profileId: 'enso-locked-v1',
  },
  turnId: 'turn-1',
  requestId: 'req-1',
  capabilityId: 'appearance.theme',
  risk: 'reversible',
  subject: { kind: 'setting', id: 'theme', label: 'Application theme' },
  outcome: 'succeeded',
  summary: 'theme: system → dark',
  occurredAt: 3,
  sequence: 0,
} as unknown as CapabilityReceipt;

describe('已结束 child 的 safe journal 投影', () => {
  it('用户与助手文本按原顺序进 messages，receipt 进 customEntries', () => {
    const records: SafeJournalRecord[] = [
      { type: 'safe-user-text', text: '把主题改成暗色', at: 1 },
      { type: 'capability-receipt', receipt, at: 3 },
      { type: 'safe-assistant-text', text: '已完成', at: 4 },
    ];

    const timeline = projectSafeJournal(records);

    expect(timeline.messages).toEqual([
      { role: 'user', content: [{ type: 'text', text: '把主题改成暗色' }], timestamp: 1 },
      { role: 'assistant', content: [{ type: 'text', text: '已完成' }], timestamp: 4 },
    ]);
    expect(timeline.customEntries).toEqual([{ kind: 'capability-receipt', receipt }]);
  });

  it('enso-operation 与 safe-model-result 不进时间线', () => {
    // 前者是内部关联 id，后者的结论已在 receipt 与助手回复里，重复展示只会让时间线更吵。
    const records = [
      {
        type: 'enso-operation',
        operationId: 'op-1',
        capabilityId: 'appearance.theme',
        toolCallId: 'call-1',
        at: 2,
      },
      {
        type: 'safe-model-result',
        toolCallId: 'call-1',
        modelResult: { ok: true, data: null },
        at: 2,
      },
    ] as unknown as SafeJournalRecord[];

    expect(projectSafeJournal(records)).toEqual({ messages: [], customEntries: [] });
  });

  it('空输入返回空数组而不是 undefined', () => {
    expect(projectSafeJournal([])).toEqual({ messages: [], customEntries: [] });
  });
});
