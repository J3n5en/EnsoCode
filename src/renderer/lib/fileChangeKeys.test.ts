import { describe, expect, it } from 'vitest';
import type { TimelineItem } from '@/stores/sessions/timeline';
import {
  advanceFileChangeBaseline,
  type FileChangeBaseline,
  fileChangeKeys,
  INITIAL_FILE_CHANGE_BASELINE,
} from './fileChangeKeys';

const edit = (
  over: Partial<Extract<TimelineItem, { kind: 'tool' }>>
): Extract<TimelineItem, { kind: 'tool' }> => ({
  kind: 'tool',
  key: over.key ?? '1-edit',
  name: over.name ?? 'edit',
  summary: 'f.ts',
  output: over.output ?? null,
  state: over.state ?? 'ok',
  edits: over.edits ?? [{ oldText: 'a', newText: 'b' }],
  writeContent: null,
  fileChanges: over.fileChanges ?? null,
  todos: null,
  durationMs: over.durationMs ?? null,
  agentMeta: null,
});

describe('fileChangeKeys', () => {
  it('counts completed edit/write with a tool result', () => {
    const keys = fileChangeKeys([
      edit({ key: '1-e', output: 'ok', durationMs: 12 }),
      edit({ key: '2-e', state: 'running', output: null }),
    ]);
    expect([...keys]).toEqual(['1-e']);
  });

  it('ignores speculative ok (no result) so a new turn does not reopen Changes', () => {
    const keys = fileChangeKeys([
      edit({ key: '1-e', state: 'ok', output: null, durationMs: null }),
    ]);
    expect(keys.size).toBe(0);
  });

  it('partial apply_patch 虽为 error，只要有实际 fileChanges 仍算已完成改动', () => {
    const item = edit({
      key: 'patch-1',
      name: 'apply_patch',
      state: 'error',
      edits: null,
      fileChanges: [{ path: 'a.ts', oldText: 'a', newText: 'b', type: 'update' }],
    });
    expect([...fileChangeKeys([item])]).toEqual(['patch-1']);
    expect(fileChangeKeys([{ ...item, key: 'patch-empty', fileChanges: [] }]).size).toBe(0);
  });
});

describe('advanceFileChangeBaseline', () => {
  const done = (key: string) => edit({ key, output: 'ok', durationMs: 5 });
  const step = (
    prev: FileChangeBaseline,
    over: Partial<Parameters<typeof advanceFileChangeBaseline>[1]>
  ) =>
    advanceFileChangeBaseline(prev, {
      conversationId: 'c1',
      historyBaseIndex: 0,
      authoritative: true,
      timeline: [],
      ...over,
    });

  // 真实场景：切到冷会话时正文已被清空，基线若记成空集，补水回来的尾窗/snapshot 里
  // 每条历史 edit 都被当成新编辑，开启该设置后冷启动或切回会话就自动弹开 Changes。
  it('冷会话切入时正文为空，补水带回的历史 edit 不算新编辑', () => {
    const cold = step(INITIAL_FILE_CHANGE_BASELINE, { authoritative: false, timeline: [] });
    const hydrated = step(cold.baseline, { timeline: [done('5-1')] });
    expect(hydrated.added).toBe(false);
  });

  // 时间线 key 是绝对下标：上滑加载更早一页带回的历史 edit 是新 key，但不是新编辑
  it('上滑加载更早一页带回的历史 edit 不算新编辑', () => {
    const tail = step(INITIAL_FILE_CHANGE_BASELINE, {
      historyBaseIndex: 10,
      timeline: [done('12-1')],
    });
    const older = step(tail.baseline, {
      historyBaseIndex: 0,
      timeline: [done('3-1'), done('12-1')],
    });
    expect(older.added).toBe(false);
  });

  it('权威正文占位后新完成的 edit 仍判为新编辑', () => {
    const seeded = step(INITIAL_FILE_CHANGE_BASELINE, { timeline: [done('1-1')] });
    expect(step(seeded.baseline, { timeline: [done('1-1'), done('2-1')] }).added).toBe(true);
  });

  it('切换会话时只占位，不把目标会话已有的 edit 当成新编辑', () => {
    const first = step(INITIAL_FILE_CHANGE_BASELINE, { timeline: [done('1-1')] });
    const switched = step(first.baseline, { conversationId: 'c2', timeline: [done('7-1')] });
    expect(switched.added).toBe(false);
  });
});
