import type { SourceAuthorityProjection } from '@shared/types/agent';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  agentSpawn,
  bindSessionProjection,
  dispatch,
  installSessionGlobals,
  loadSessionModules,
  readParentHistoryTail,
  requestSnapshot,
  resetSessionHarness,
  selectConversation,
  sessionsModule,
} from './index.testUtils';

const projection = {
  sourceProjection: { projects: [], conversations: [] } as SourceAuthorityProjection,
  nextConversationId: 'parent',
};
bindSessionProjection(projection);
installSessionGlobals();

const ARCHIVED_AT = 1_700_000_000_000;

function seedArchived() {
  sessionsModule.useSessionsStore.setState((state) => ({
    conversations: {
      ...state.conversations,
      done: {
        ...state.conversations.parent,
        id: 'done',
        title: '派出的活',
        started: false,
        spawning: false,
        status: 'idle',
        sessionFile: '/tmp/done.jsonl',
        messages: [],
        archived: true,
        archivedAt: ARCHIVED_AT,
        unread: false,
      },
    },
    order: ['parent', 'done'],
    activeId: 'parent',
  }));
}

describe('只读旁观已归档会话', () => {
  beforeAll(async () => {
    await loadSessionModules();
  });

  beforeEach(async () => {
    await resetSessionHarness();
    seedArchived();
    requestSnapshot.mockClear();
    agentSpawn.mockClear();
    dispatch.mockClear();
    selectConversation.mockClear();
    readParentHistoryTail.mockResolvedValue({
      ok: true,
      messages: [{ role: 'assistant', content: [{ type: 'text', text: '做完了' }] }],
      baseIndex: 40,
    });
  });

  it('只读 jsonl 尾窗渲染，可继续上翻；归档、未读、侧栏、当前会话都不变，也不要 worker', async () => {
    const release = sessionsModule.peekConversation('done', { readOnly: true });
    await expect
      .poll(() => sessionsModule.useSessionsStore.getState().conversations.done.messages)
      .toHaveLength(1);
    const state = sessionsModule.useSessionsStore.getState();
    const done = state.conversations.done;
    expect(readParentHistoryTail).toHaveBeenCalledWith('done');
    expect(done.historyBaseIndex).toBe(40);
    expect(done.archived).toBe(true);
    expect(done.archivedAt).toBe(ARCHIVED_AT);
    expect(done.unread).toBe(false);
    expect(done.started).toBe(false);
    expect(state.activeId).toBe('parent');
    expect(state.order).toEqual(['parent', 'done']);
    release();
    expect(requestSnapshot).not.toHaveBeenCalled();
    expect(agentSpawn).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
    expect(selectConversation).not.toHaveBeenCalled();
    expect(sessionsModule.useSessionsStore.getState().conversations.done.archived).toBe(true);
  });

  it('取消归档真的清掉归档标记', () => {
    sessionsModule.useSessionsStore.getState().toggleArchiveConversation('done');
    const done = sessionsModule.useSessionsStore.getState().conversations.done;
    expect(done.archived).toBeUndefined();
    expect(done.archivedAt).toBeUndefined();
  });
});
