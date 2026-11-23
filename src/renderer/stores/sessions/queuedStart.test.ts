import type { SourceAuthorityProjection } from '@shared/types/agent';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  agentPrompt,
  agentSpawn,
  bindSessionProjection,
  installSessionGlobals,
  loadSessionModules,
  requestSnapshot,
  resetSessionHarness,
  secretaryStartQueued,
  sessionsModule,
} from './index.testUtils';

let sourceProjection: SourceAuthorityProjection = { projects: [], conversations: [] };
let nextConversationId = 'parent';
bindSessionProjection({
  get sourceProjection() {
    return sourceProjection;
  },
  set sourceProjection(value) {
    sourceProjection = value;
  },
  get nextConversationId() {
    return nextConversationId;
  },
  set nextConversationId(value) {
    nextConversationId = value;
  },
});
installSessionGlobals();

describe('排队会话', () => {
  beforeAll(async () => {
    await loadSessionModules();
  });

  beforeEach(async () => {
    await resetSessionHarness();
  });

  function queueParent() {
    const store = sessionsModule.useSessionsStore;
    const id = store.getState().activeId;
    if (!id) throw new Error('missing parent');
    store.setState((state) => ({
      conversations: {
        ...state.conversations,
        [id]: {
          ...state.conversations[id],
          queuedStart: { queuedAt: 1, text: 'first' },
          messages: [],
          sessionFile: '/tmp/queued.jsonl',
        },
      },
    }));
    return id;
  }

  it('发送走 startQueued，被拒时不回显并把原文退回输入框', async () => {
    const id = queueParent();
    secretaryStartQueued.mockResolvedValueOnce({ ok: false, error: 'full' });
    agentSpawn.mockClear();
    agentPrompt.mockClear();
    const error = await sessionsModule.useSessionsStore
      .getState()
      .send('follow', { providerId: 'p', modelId: 'm', cwd: '/workspace' });
    expect(error).toBe('full');
    expect(secretaryStartQueued).toHaveBeenCalledWith(id, { text: 'follow' });
    expect(agentSpawn).not.toHaveBeenCalled();
    expect(agentPrompt).not.toHaveBeenCalled();
    const conversation = sessionsModule.useSessionsStore.getState().conversations[id];
    expect(conversation?.messages).toEqual([]);
    expect(conversation?.draftText).toBe('follow');
    expect(conversation?.error).toBe('full');
  });

  it('不 resume、不向 worker 要快照', async () => {
    const id = queueParent();
    agentSpawn.mockClear();
    requestSnapshot.mockClear();
    await sessionsModule.useSessionsStore.getState().resumeConversation(id);
    sessionsModule.useSessionsStore.getState().selectConversation(id);
    await Promise.resolve();
    expect(agentSpawn).not.toHaveBeenCalled();
    expect(requestSnapshot).not.toHaveBeenCalled();
  });
});
