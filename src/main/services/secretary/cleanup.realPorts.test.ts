import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { realCleanupPorts } from './cleanup';
import { SecretaryStore } from './store';

const state = vi.hoisted(() => ({
  conversations: {} as Record<string, Record<string, unknown>>,
}));

vi.mock('../../ipc/settings', () => ({
  readPersistedConversations: () => state.conversations,
  patchConversationsState: (patch: (draft: typeof state) => void) => patch(state),
}));

describe('生产清理端口的归档与取消归档', () => {
  let dir = '';
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'secretary-archive-'));
    state.conversations = { c1: { title: '写发布说明', projectId: 'p1' } };
    new SecretaryStore(dir).saveDispatch({
      version: 1,
      dispatched: {
        c1: {
          conversationId: 'c1',
          projectId: 'p1',
          secretaryConversationId: 'sec-1',
          createdAt: 100,
          turn: 1,
          lastState: 'idle',
          lastEventAt: 100,
          lastResult: { kind: 'goal-complete', turn: 1, at: 200 },
        },
      },
      named: [],
      proposals: {},
      outbox: [],
    });
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('归档时在派发记录上记下来源与时刻，取消归档时会话行与记录一起清掉', async () => {
    const ports = realCleanupPorts({ id: 's1', dir, projectId: null });
    await ports.archive('c1', 500, 'session_archive');
    expect(state.conversations.c1).toMatchObject({ archived: true, archivedAt: 500 });
    expect(new SecretaryStore(dir).dispatch().dispatched.c1?.secretaryArchived).toEqual({
      at: 500,
      via: 'session_archive',
    });

    await ports.unarchive('c1');
    expect(state.conversations.c1).toEqual({ title: '写发布说明', projectId: 'p1' });
    expect(new SecretaryStore(dir).dispatch().dispatched.c1?.secretaryArchived).toBeUndefined();
  });
});
