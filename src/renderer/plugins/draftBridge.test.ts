import { afterEach, describe, expect, it } from 'vitest';
import type { MentionSegment } from '@/components/chat/mentionComposer';
import {
  draftRev,
  handleDraftRequest,
  prefillDraft,
  registerDraftTarget,
  takePendingDraft,
} from './draftBridge';

function fakeTarget(key: string, initial: MentionSegment[]) {
  const state = { segments: initial, busy: false };
  return {
    state,
    target: {
      key,
      segments: () => state.segments,
      insertText: (text: string) => {
        state.segments = [...state.segments, { type: 'text', text }];
      },
      setText: (text: string) => {
        state.segments = text ? [{ type: 'text', text }] : [];
      },
      busy: () => state.busy,
    },
  };
}

let dispose: (() => void) | null = null;
afterEach(() => {
  dispose?.();
  dispose = null;
});

describe('草稿桥', () => {
  it('预填：输入框已切到该会话时直接写入，否则留到切过去时取走一次', () => {
    const { state, target } = fakeTarget('s1', []);
    dispose = registerDraftTarget(target);
    prefillDraft('s1', '已在前台');
    expect(state.segments).toEqual([{ type: 'text', text: '已在前台' }]);
    expect(takePendingDraft('s1')).toBeUndefined();

    prefillDraft('s2', '稍后');
    expect(state.segments).toEqual([{ type: 'text', text: '已在前台' }]);
    expect(takePendingDraft('s2')).toBe('稍后');
    expect(takePendingDraft('s2')).toBeUndefined();
  });

  it('读取当前会话草稿，返回版本信息', () => {
    const { target } = fakeTarget('c1', [{ type: 'text', text: 'hello' }]);
    dispose = registerDraftTarget(target);
    const res = handleDraftRequest({ sessionId: 'c1', op: 'readDraft', payload: {} });
    expect(res).toEqual({
      ok: true,
      value: {
        text: 'hello',
        hasReferences: false,
        generation: 'c1',
        rev: draftRev([{ type: 'text', text: 'hello' }]),
      },
    });
  });

  it('会话不匹配或没有输入框时拒绝', () => {
    expect(handleDraftRequest({ sessionId: 'c1', op: 'readDraft', payload: {} })).toMatchObject({
      ok: false,
      code: 'NO_COMPOSER',
    });
    const { target } = fakeTarget('c2', []);
    dispose = registerDraftTarget(target);
    expect(handleDraftRequest({ sessionId: 'c1', op: 'readDraft', payload: {} })).toMatchObject({
      ok: false,
      code: 'NO_COMPOSER',
    });
  });

  it('插入文本；组字或锁定时拒绝', () => {
    const { target, state } = fakeTarget('c1', []);
    dispose = registerDraftTarget(target);
    expect(
      handleDraftRequest({ sessionId: 'c1', op: 'insertText', payload: { text: 'x' } })
    ).toMatchObject({ ok: true });
    expect(state.segments).toEqual([{ type: 'text', text: 'x' }]);
    state.busy = true;
    expect(
      handleDraftRequest({ sessionId: 'c1', op: 'insertText', payload: { text: 'y' } })
    ).toMatchObject({ ok: false, code: 'DRAFT_BUSY' });
  });

  it('整体替换按版本校验，读取后被改过则拒绝', () => {
    const { target, state } = fakeTarget('c1', [{ type: 'text', text: 'a' }]);
    dispose = registerDraftTarget(target);
    const read = handleDraftRequest({ sessionId: 'c1', op: 'readDraft', payload: {} });
    const { generation, rev } = (read as { value: { generation: string; rev: string } }).value;
    state.segments = [{ type: 'text', text: 'ab' }];
    expect(
      handleDraftRequest({
        sessionId: 'c1',
        op: 'replaceDraft',
        payload: { text: 'z', expect: { generation, rev } },
      })
    ).toMatchObject({ ok: false, code: 'DRAFT_CHANGED' });
    const fresh = draftRev(state.segments);
    expect(
      handleDraftRequest({
        sessionId: 'c1',
        op: 'replaceDraft',
        payload: { text: 'z', expect: { generation: 'c1', rev: fresh } },
      })
    ).toMatchObject({ ok: true });
    expect(state.segments).toEqual([{ type: 'text', text: 'z' }]);
  });

  it('草稿里有文件引用时不允许整体替换', () => {
    const { target } = fakeTarget('c1', [{ type: 'file', path: '/a' }]);
    dispose = registerDraftTarget(target);
    expect(
      handleDraftRequest({ sessionId: 'c1', op: 'replaceDraft', payload: { text: 'z' } })
    ).toMatchObject({ ok: false, code: 'DRAFT_HAS_REFERENCES' });
  });

  it('旧的登记被新的覆盖后，旧的注销不影响新的', () => {
    const first = fakeTarget('c1', []);
    const second = fakeTarget('c2', []);
    const disposeFirst = registerDraftTarget(first.target);
    dispose = registerDraftTarget(second.target);
    disposeFirst();
    expect(handleDraftRequest({ sessionId: 'c2', op: 'readDraft', payload: {} })).toMatchObject({
      ok: true,
    });
  });
});
