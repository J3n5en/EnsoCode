import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SECRETARY_ID, SecretaryRegistry } from './registry';
import { SecretaryStore } from './store';

const state = vi.hoisted(() => ({
  root: '',
  registry: null as unknown as SecretaryRegistry,
  conversations: [] as { conversationId: string; projectId: string }[],
  rows: {} as Record<string, Record<string, unknown>>,
  release: vi.fn((_id: string): Promise<unknown> => Promise.resolve({ ok: true })),
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

const ports = () => ({ forget: vi.fn(), stop: vi.fn(async () => {}) });

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
    state.release = vi.fn(() => Promise.resolve({ ok: true }));
  });

  it('会话释放失败也返回 ok，秘书记录与目录已删除，派出会话只清归属', async () => {
    const ctx = setup(2);
    state.release = vi.fn(() => Promise.reject(new Error('release timed out')));
    const result = await deleteSecretary(ctx, ports());
    expect(result).toEqual({ ok: true });
    expect(existsSync(ctx.dir)).toBe(false);
    expect(state.registry.has(ctx.id)).toBe(false);
    expect(state.rows.managed).toEqual({});
    expect(state.rows['own-0']).toBeUndefined();
  });

  it('会话释放卡住不等：删除照样立刻完成', async () => {
    const ctx = setup(2);
    state.release = vi.fn(() => new Promise(() => {}));
    const settled = await Promise.race([
      deleteSecretary(ctx, ports()),
      new Promise((resolve) => setTimeout(() => resolve('hung'), 200)),
    ]);
    expect(settled).toEqual({ ok: true });
    expect(state.registry.has(ctx.id)).toBe(false);
  });

  it('秘书自己的会话并行释放', async () => {
    const ctx = setup(3);
    let inflight = 0;
    let peak = 0;
    state.release = vi.fn(async () => {
      inflight += 1;
      peak = Math.max(peak, inflight);
      await Promise.resolve();
      inflight -= 1;
      return { ok: true };
    });
    await deleteSecretary(ctx, ports());
    expect(peak).toBe(3);
  });

  it('撤续跑抛错不阻断文件删除', async () => {
    const ctx = setup(1);
    const result = await deleteSecretary(ctx, {
      ...ports(),
      forget: () => {
        throw new Error('driver gone');
      },
    });
    expect(result).toEqual({ ok: true });
    expect(existsSync(ctx.dir)).toBe(false);
  });

  it('登记删除失败：什么都不动（会话行、派出归属、续跑、会话、联系方式、目录都原样）', async () => {
    const ctx = setup(2);
    const before = structuredClone(state.rows);
    vi.spyOn(state.registry, 'remove').mockImplementation(() => {
      throw new Error('EACCES');
    });
    const p = ports();
    const result = await deleteSecretary(ctx, p);
    expect(result).toEqual({ ok: false, error: 'EACCES' });
    expect(state.rows).toEqual(before);
    expect(p.forget).not.toHaveBeenCalled();
    expect(p.stop).not.toHaveBeenCalled();
    expect(state.release).not.toHaveBeenCalled();
    expect(existsSync(join(ctx.dir, 'dispatch.json'))).toBe(true);
  });

  it('登记删除后才停宿主与联系方式，且等联系方式收尾后才删目录', async () => {
    const ctx = setup(1);
    const seen: { registered: boolean; dir: boolean }[] = [];
    await deleteSecretary(ctx, {
      forget: () => {},
      stop: async () => {
        seen.push({ registered: state.registry.has(ctx.id), dir: existsSync(ctx.dir) });
        await Promise.resolve();
        seen.push({ registered: state.registry.has(ctx.id), dir: existsSync(ctx.dir) });
      },
    });
    expect(seen).toEqual([
      { registered: false, dir: true },
      { registered: false, dir: true },
    ]);
    expect(existsSync(ctx.dir)).toBe(false);
  });

  it('删 default 秘书只删它自己的文件：别的秘书、登记文件、用户会话与别的秘书派出的会话都不碰', async () => {
    const other = setup(0);
    const root = state.root;
    const own = new SecretaryStore(root);
    own.saveDispatch({
      version: 1,
      dispatched: {
        mine: {
          conversationId: 'mine',
          projectId: 'p1',
          secretaryConversationId: 'def-0',
          createdAt: 1,
          turn: 0,
          lastState: 'idle',
          lastEventAt: 1,
        },
      },
      named: [],
      outbox: [],
    } as never);
    writeFileSync(join(root, 'persona.md'), 'x');
    mkdirSync(join(root, 'workspace'), { recursive: true });
    writeFileSync(join(root, 'unrelated.txt'), 'keep');
    state.conversations = [
      { conversationId: 'def-0', projectId: 'def-project' },
      { conversationId: 'other-0', projectId: 'other-project' },
      { conversationId: 'user-0', projectId: 'p1' },
    ];
    state.rows = {
      'def-0': {},
      'other-0': {},
      'user-0': { title: 'mine' },
      mine: { secretaryOrigin: { secretaryConversationId: 'def-0' } },
      managed: { secretaryOrigin: { secretaryId: other.id, secretaryConversationId: 'other-0' } },
    };
    const result = await deleteSecretary(
      { id: DEFAULT_SECRETARY_ID, dir: root, projectId: 'def-project' },
      ports()
    );
    expect(result).toEqual({ ok: true });
    expect(state.registry.list().map((entry) => entry.id)).toEqual([other.id]);
    expect(existsSync(join(root, 'secretaries.json'))).toBe(true);
    expect(existsSync(join(other.dir, 'dispatch.json'))).toBe(true);
    expect(existsSync(join(root, 'unrelated.txt'))).toBe(true);
    for (const name of ['dispatch.json', 'persona.md', 'workspace'])
      expect(existsSync(join(root, name))).toBe(false);
    expect(state.rows).toEqual({
      'other-0': {},
      'user-0': { title: 'mine' },
      mine: {},
      managed: { secretaryOrigin: { secretaryId: other.id, secretaryConversationId: 'other-0' } },
    });
    expect(state.release.mock.calls.map(([id]) => id)).toEqual(['def-0']);
  });
});
