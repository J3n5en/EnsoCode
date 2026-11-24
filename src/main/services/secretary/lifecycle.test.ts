import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SecretaryRegistry } from './registry';
import { SecretaryStore } from './store';

const state = vi.hoisted(() => ({
  root: '',
  registry: null as unknown as SecretaryRegistry,
  conversations: [] as { conversationId: string; projectId: string }[],
  rows: {} as Record<string, Record<string, unknown>>,
  release: (_id: string): Promise<unknown> => Promise.resolve({ ok: true }),
}));

vi.mock('@platform', () => ({ app: { getPath: () => state.root } }));
vi.mock('../../ipc/settings', () => ({
  patchConversationsState: (
    patch: (s: { conversations: Record<string, Record<string, unknown>>; order: string[] }) => void
  ) => patch({ conversations: state.rows, order: Object.keys(state.rows) }),
}));
vi.mock('../../ipc/agent', () => ({
  getSourceAuthorityRegistry: () => ({
    projection: () => ({ conversations: state.conversations }),
    removeSecretaryProject: () => {},
  }),
  setAskRelayFromMain: () => ({ ok: true }),
  isRootSessionAlive: () => true,
  releaseRootFromMain: (id: string) => state.release(id),
}));
vi.mock('../memoryCleanup', () => ({ removeMemorySpace: async () => {} }));
vi.mock('./secretaries', () => ({
  secretaryRegistry: () => state.registry,
  secretaryContext: () => null,
  forgetSecretaryProject: () => {},
}));
vi.mock('./profile', () => ({ forgetSecretaryProfile: () => {} }));
vi.mock('./tools', () => ({ forgetSecretaryHandlers: () => {} }));

const { deleteSecretary } = await import('./lifecycle');

function setup(ownSessions: number) {
  state.root = mkdtempSync(join(tmpdir(), 'secretary-lifecycle-'));
  state.registry = new SecretaryRegistry(state.root, { now: () => 1, randomId: () => 'abc' });
  const entry = state.registry.create();
  const dir = state.registry.dir(entry.id);
  new SecretaryStore(dir).saveDispatch({
    version: 1,
    dispatched: {
      managed: {
        conversationId: 'managed',
        projectId: 'p1',
        secretaryConversationId: 'own-0',
        createdAt: 1,
        turn: 0,
        lastState: 'idle',
        lastEventAt: 1,
      },
    },
    named: [],
    outbox: [],
  } as never);
  state.conversations = Array.from({ length: ownSessions }, (_, index) => ({
    conversationId: `own-${index}`,
    projectId: 'sec-project',
  }));
  state.rows = {
    managed: { secretaryOrigin: { secretaryId: entry.id, secretaryConversationId: 'own-0' } },
    ...Object.fromEntries(state.conversations.map((c) => [c.conversationId, {}])),
  };
  return { id: entry.id, dir, projectId: 'sec-project' };
}

describe('删除秘书：先落盘，再做清理', () => {
  beforeEach(() => {
    state.release = () => Promise.resolve({ ok: true });
  });

  it('会话释放失败也返回 ok，秘书记录与目录已删除，派出会话只清归属', async () => {
    const ctx = setup(2);
    state.release = () => Promise.reject(new Error('release timed out'));
    const result = await deleteSecretary(ctx, { forget: () => {} });
    expect(result).toEqual({ ok: true });
    expect(existsSync(ctx.dir)).toBe(false);
    expect(state.registry.has(ctx.id)).toBe(false);
    expect(state.rows.managed).toEqual({});
    expect(state.rows['own-0']).toBeUndefined();
  });

  it('会话释放卡住不等：删除照样立刻完成', async () => {
    const ctx = setup(2);
    state.release = () => new Promise(() => {});
    const settled = await Promise.race([
      deleteSecretary(ctx, { forget: () => {} }),
      new Promise((resolve) => setTimeout(() => resolve('hung'), 200)),
    ]);
    expect(settled).toEqual({ ok: true });
    expect(state.registry.has(ctx.id)).toBe(false);
  });

  it('秘书自己的会话并行释放', async () => {
    const ctx = setup(3);
    let inflight = 0;
    let peak = 0;
    state.release = async () => {
      inflight += 1;
      peak = Math.max(peak, inflight);
      await Promise.resolve();
      inflight -= 1;
      return { ok: true };
    };
    await deleteSecretary(ctx, { forget: () => {} });
    expect(peak).toBe(3);
  });

  it('撤续跑抛错不阻断文件删除', async () => {
    const ctx = setup(1);
    const result = await deleteSecretary(ctx, {
      forget: () => {
        throw new Error('driver gone');
      },
    });
    expect(result).toEqual({ ok: true });
    expect(existsSync(ctx.dir)).toBe(false);
  });
});
