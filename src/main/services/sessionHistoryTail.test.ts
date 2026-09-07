import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import * as projection from '../../agent/projection';
import {
  projectParentHistoryPage,
  projectParentHistoryTail,
  resolveParentHistoryFile,
} from './sessionHistoryTail';

const sessionDir = '/tmp/agent/sessions';

describe('resolveParentHistoryFile', () => {
  it('accepts a file inside the sessions directory', () => {
    expect(
      resolveParentHistoryFile(sessionDir, path.join(sessionDir, '2026-01-01T00-00-00-000Z.jsonl'))
    ).toBe(path.resolve(sessionDir, '2026-01-01T00-00-00-000Z.jsonl'));
  });

  it('rejects traversal and missing files', () => {
    expect(
      resolveParentHistoryFile(sessionDir, path.join(sessionDir, '../escape.jsonl'))
    ).toBeNull();
    expect(resolveParentHistoryFile(sessionDir, undefined)).toBeNull();
    expect(resolveParentHistoryFile(sessionDir, '')).toBeNull();
  });
});

const makeBranch = (count: number, text = (i: number) => `m${i}`) =>
  Array.from({ length: count }, (_, i) => ({
    type: 'message',
    message: { role: 'user', content: [{ type: 'text', text: text(i) }], timestamp: i },
  }));

describe('projectParentHistoryPage', () => {
  it('只投影 beforeIndex 之前的短历史', () => {
    const page = projectParentHistoryPage(makeBranch(3) as never, 1);
    expect(page).toEqual({
      baseIndex: 0,
      messages: [{ role: 'user', content: [{ type: 'text', text: 'm0' }], timestamp: 0 }],
    });
  });
  it('80 条历史在 beforeIndex=20 时只返回前 20 条', () => {
    const page = projectParentHistoryPage(makeBranch(80) as never, 20);
    expect(page.baseIndex).toBe(0);
    expect(page.messages).toHaveLength(20);
    expect(page.messages.at(-1)).toHaveProperty('timestamp', 19);
  });
  it('按 60 条预算先截页再投影，不扫整卷', () => {
    expect(projectParentHistoryPage).toBeTypeOf('function');
    const spy = vi.spyOn(projection, 'projectMessage');
    const page = projectParentHistoryPage(makeBranch(80) as never, 70);
    expect(page.baseIndex).toBe(10);
    expect(page.messages).toHaveLength(60);
    expect(spy).toHaveBeenCalledTimes(60);
    spy.mockRestore();
  });
  it('同时遵守 600KB 字节预算', () => {
    const page = projectParentHistoryPage(makeBranch(3, () => 'x'.repeat(300_000)) as never, 3);
    expect(page.baseIndex).toBe(2);
    expect(page.messages).toHaveLength(1);
  });
  it('beforeIndex 不大于 0 或历史为空时返回空页', () => {
    for (const beforeIndex of [-1, 0])
      expect(projectParentHistoryPage(makeBranch(2) as never, beforeIndex)).toEqual({
        messages: [],
        baseIndex: 0,
      });
    expect(projectParentHistoryPage([] as never, 10)).toEqual({ messages: [], baseIndex: 0 });
  });
});

describe('projectParentHistoryTail', () => {
  it('projects and windows from the end', () => {
    const branch = [
      {
        type: 'message',
        message: { role: 'user', content: [{ type: 'text', text: 'hi' }], timestamp: 1 },
      },
      {
        type: 'message',
        message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }], timestamp: 2 },
      },
      { type: 'custom', customType: 'other', data: {} },
    ];
    const tail = projectParentHistoryTail(branch as never);
    expect(tail.baseIndex).toBe(0);
    expect(tail.messages).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'hi' }], timestamp: 1 },
      { role: 'assistant', content: [{ type: 'text', text: 'ok' }], timestamp: 2 },
    ]);
  });

  it('drops unprojected fields', () => {
    const tail = projectParentHistoryTail([
      {
        type: 'message',
        message: {
          role: 'user',
          content: [{ type: 'text', text: 'hi' }],
          providerData: { secret: true },
        },
      },
    ] as never);
    expect(tail.messages[0]).not.toHaveProperty('providerData');
  });

  it('先截尾窗再投影，不扫整卷', () => {
    const spy = vi.spyOn(projection, 'projectMessage');
    const branch = Array.from({ length: 80 }, (_, i) => ({
      type: 'message',
      message: { role: 'user', content: [{ type: 'text', text: `m${i}` }], timestamp: i },
    }));
    const tail = projectParentHistoryTail(branch as never);
    expect(tail.baseIndex).toBe(20);
    expect(tail.messages).toHaveLength(60);
    expect(spy).toHaveBeenCalledTimes(60);
    spy.mockRestore();
  });
});
