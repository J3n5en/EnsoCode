import { describe, expect, it } from 'vitest';
import {
  resumeSnapshotPayloads,
  SNAPSHOT_BYTE_BUDGET,
  SNAPSHOT_TAIL_MESSAGES,
  takeSnapshotTail,
} from './snapshotTail';

describe('snapshot 尾窗', () => {
  it('空历史返回空窗口和零起点', () => {
    expect(takeSnapshotTail([], 0)).toEqual({ messages: [], baseIndex: 0 });
  });

  it('短历史不裁剪，并且只取 endIndex 之前的消息', () => {
    const messages = [{ text: 'm0' }, { text: 'm1' }, { text: 'later' }];
    expect(takeSnapshotTail(messages, 2)).toEqual({
      messages: messages.slice(0, 2),
      baseIndex: 0,
    });
  });

  it('消息数达到 60 条时只保留最新尾窗', () => {
    expect(SNAPSHOT_TAIL_MESSAGES).toBe(60);
    const messages = Array.from({ length: 65 }, (_, index) => ({ text: `m${index}` }));
    expect(takeSnapshotTail(messages, messages.length)).toEqual({
      messages: messages.slice(5),
      baseIndex: 5,
    });
  });

  it('按 UTF-8 JSON 字节预算裁剪', () => {
    expect(SNAPSHOT_BYTE_BUDGET).toBe(600_000);
    const messages = [
      { text: 'old' },
      { text: '中'.repeat(110_000) },
      { text: '中'.repeat(110_000) },
    ];
    expect(takeSnapshotTail(messages, messages.length)).toEqual({
      messages: [messages[2]],
      baseIndex: 2,
    });
  });

  it('最后一条消息自身超过预算时仍至少保留该消息', () => {
    const messages = [{ text: 'old' }, { text: 'x'.repeat(SNAPSHOT_BYTE_BUDGET + 1) }];
    expect(takeSnapshotTail(messages, messages.length)).toEqual({
      messages: [messages[1]],
      baseIndex: 1,
    });
  });
});

describe('resumeSnapshotPayloads', () => {
  it('长历史先发带 baseIndex 的尾窗，再发全量', () => {
    const messages = Array.from({ length: 65 }, (_, index) => ({ text: `m${index}` }));
    const [tail, full] = resumeSnapshotPayloads(messages);
    expect(tail).toEqual({ messages: messages.slice(5), baseIndex: 5 });
    expect(full).toEqual({ messages, baseIndex: 0 });
  });

  it('短历史只发一包全量，避免重复 snapshot', () => {
    const messages = [{ text: 'only' }];
    expect(resumeSnapshotPayloads(messages)).toEqual([{ messages, baseIndex: 0 }]);
  });
});
