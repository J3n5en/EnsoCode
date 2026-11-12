import { describe, expect, it } from 'vitest';
import {
  applyMicrocompact,
  MICROCOMPACT_IDLE_MS,
  MICROCOMPACT_KEEP_RECENT,
  MICROCOMPACT_PLACEHOLDER,
  microcompactContextEdits,
  microcompactExtension,
  selectMicrocompactTargets,
} from './microcompact';

const NOW = 10 * MICROCOMPACT_IDLE_MS;

function result(id: string, chars: number, toolName = 'read', extra: object = {}) {
  return {
    role: 'toolResult',
    toolCallId: id,
    toolName,
    content: [{ type: 'text', text: 'x'.repeat(chars) }],
    isError: false,
    ...extra,
  };
}
const assistant = (timestamp: number) => ({ role: 'assistant', content: [], timestamp });
const user = { role: 'user', content: 'go' };

describe('selectMicrocompactTargets', () => {
  it('工具结果总量未超阈值且缓存未冷时不清', () => {
    const messages = [
      user,
      assistant(NOW - 1000),
      ...[1, 2, 3, 4, 5, 6, 7].map((i) => result(`c${i}`, 1000)),
    ];
    expect(selectMicrocompactTargets(messages, NOW, new Set())).toEqual([]);
  });

  it('总量超阈值：从最旧开始清到低水位，最近几条始终保留', () => {
    const messages = [
      user,
      assistant(NOW - 1000),
      ...Array.from({ length: 10 }, (_, i) => result(`c${i}`, 100_000)),
    ];
    const targets = selectMicrocompactTargets(messages, NOW, new Set());
    // 1,000,000 → 清到 ≤250k：清掉 8 条会碰到保留区，最多只能清前 5 条
    expect(targets).toEqual(['c0', 'c1', 'c2', 'c3', 'c4']);
    const kept = Array.from({ length: MICROCOMPACT_KEEP_RECENT }, (_, i) => `c${9 - i}`);
    for (const id of kept) expect(targets).not.toContain(id);
  });

  it('上一次回复距今超过空闲阈值（缓存已冷）：清掉除最近几条外的全部可清结果', () => {
    const messages = [
      assistant(NOW - MICROCOMPACT_IDLE_MS - 1),
      ...Array.from({ length: 8 }, (_, i) => result(`c${i}`, 10)),
      user,
    ];
    expect(selectMicrocompactTargets(messages, NOW, new Set())).toEqual(['c0', 'c1', 'c2']);
  });

  it('错误结果、不可清的工具、空结果、已清除与已选中的不参与', () => {
    const messages = [
      assistant(NOW - MICROCOMPACT_IDLE_MS - 1),
      result('err', 10, 'read', { isError: true }),
      result('sub', 10, 'subagent'),
      result('empty', 0),
      {
        ...result('done', 0),
        content: [{ type: 'text', text: MICROCOMPACT_PLACEHOLDER }],
      },
      result('picked', 10),
      result('old', 10),
      ...Array.from({ length: MICROCOMPACT_KEEP_RECENT }, (_, i) => result(`k${i}`, 10, 'bash')),
    ];
    expect(selectMicrocompactTargets(messages, NOW, new Set(['picked']))).toEqual(['old']);
  });
});

describe('applyMicrocompact', () => {
  it('只替换选中结果的正文，元数据不变；没有命中时返回同一引用', () => {
    const messages = [user, result('a', 10), result('b', 10)];
    expect(applyMicrocompact(messages, new Set())).toBe(messages);
    const out = applyMicrocompact(messages, new Set(['a']));
    expect(out[1]).toMatchObject({
      role: 'toolResult',
      toolCallId: 'a',
      content: [{ type: 'text', text: MICROCOMPACT_PLACEHOLDER }],
    });
    expect(out[2]).toBe(messages[2]);
    expect(messages[1].content).toEqual([{ type: 'text', text: 'x'.repeat(10) }]);
  });
});

describe('microcompactContextEdits', () => {
  it('选中且投影里尚未替换的结果写成 context_edit，已替换的报告为已落盘', () => {
    const entries = [
      { sourceEntry: { id: 'e1', type: 'message' }, messages: [result('a', 10)] },
      {
        sourceEntry: { id: 'e2', type: 'message' },
        messages: [
          { ...result('b', 0), content: [{ type: 'text', text: MICROCOMPACT_PLACEHOLDER }] },
        ],
      },
      { sourceEntry: { id: 'e3', type: 'message' }, messages: [result('c', 10)] },
    ];
    expect(microcompactContextEdits(entries, new Set(['a', 'b']))).toEqual({
      edits: [
        {
          type: 'context_edit',
          targetId: 'e1',
          replacement: { content: [{ type: 'text', text: MICROCOMPACT_PLACEHOLDER }] },
        },
      ],
      settled: ['b'],
    });
  });
});

describe('microcompactExtension', () => {
  it('请求前替换并在回合结束落盘，落盘后的请求保持同一替换', () => {
    const handlers = new Map<string, (event: unknown) => unknown>();
    const extension = microcompactExtension(() => NOW) as { factory: (pi: never) => void };
    extension.factory({
      on: (name: string, handler: (event: unknown) => unknown) => handlers.set(name, handler),
    } as never);
    const messages = [
      assistant(NOW - MICROCOMPACT_IDLE_MS - 1),
      ...Array.from({ length: 6 }, (_, i) => result(`c${i}`, 10)),
      user,
    ];
    const sent = handlers.get('context')?.({ messages }) as { messages: typeof messages };
    expect(sent.messages[1].content).toEqual([{ type: 'text', text: MICROCOMPACT_PLACEHOLDER }]);
    expect(sent.messages[2]).toBe(messages[2]);

    const entries = messages
      .filter((m) => m.role === 'toolResult')
      .map((m, i) => ({ sourceEntry: { id: `e${i}`, type: 'message' }, messages: [m] }));
    const end = handlers.get('turn_end')?.({
      entries: [],
      context: { contextEntries: entries },
    }) as {
      entries: Array<{ targetId: string }>;
    };
    expect(end.entries.map((e) => e.targetId)).toEqual(['e0']);

    // 同一运行内的下一次请求：上一条回复已是新的，不再按空闲触发，但已选中的仍替换
    const next = [...messages, assistant(NOW)];
    const again = handlers.get('context')?.({ messages: next }) as { messages: typeof next };
    expect(again.messages[1].content).toEqual([{ type: 'text', text: MICROCOMPACT_PLACEHOLDER }]);
  });
});
