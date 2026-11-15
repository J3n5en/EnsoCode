import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  secretary: { profile: null as unknown, projectId: 'sec' as string | null },
  openWelcome: vi.fn(),
  newSecretaryConversation: vi.fn(),
  selectConversation: vi.fn(),
  sessions: {
    order: [] as string[],
    conversations: {} as Record<
      string,
      { projectId: string; archived?: boolean; lastActiveAt?: number } | undefined
    >,
  },
}));

vi.mock('@/stores/secretary', () => ({
  useSecretaryStore: {
    getState: () => ({
      secretary: h.secretary,
      openWelcome: h.openWelcome,
      newSecretaryConversation: h.newSecretaryConversation,
    }),
  },
}));
vi.mock('@/stores/sessions', () => ({
  useSessionsStore: {
    getState: () => ({ ...h.sessions, selectConversation: h.selectConversation }),
  },
}));

const { openSecretary } = await import('./openSecretary');

describe('openSecretary', () => {
  beforeEach(() => {
    h.secretary = { profile: null, projectId: 'sec' };
    h.sessions = { order: [], conversations: {} };
    h.openWelcome.mockClear();
    h.newSecretaryConversation.mockClear();
    h.selectConversation.mockClear();
  });

  it('还没设置过、也没有会话时进欢迎页', () => {
    openSecretary();
    expect(h.openWelcome).toHaveBeenCalledTimes(1);
    expect(h.newSecretaryConversation).not.toHaveBeenCalled();
  });

  it('已设置时打开最近活跃的秘书会话', () => {
    h.secretary = { profile: { name: '秘书' }, projectId: 'sec' };
    h.sessions = {
      order: ['a', 'b'],
      conversations: {
        a: { projectId: 'sec', lastActiveAt: 1 },
        b: { projectId: 'sec', lastActiveAt: 5 },
      },
    };
    openSecretary();
    expect(h.selectConversation).toHaveBeenCalledWith('b');
    expect(h.newSecretaryConversation).not.toHaveBeenCalled();
  });

  it('已设置但一个会话都没有时新建一个', () => {
    h.secretary = { profile: { name: '秘书' }, projectId: 'sec' };
    openSecretary();
    expect(h.newSecretaryConversation).toHaveBeenCalledTimes(1);
    expect(h.openWelcome).not.toHaveBeenCalled();
  });

  it('选了「聊着设置」还没确认档案时，再点入口回到那个会话而不是欢迎页', () => {
    h.sessions = {
      order: ['a'],
      conversations: { a: { projectId: 'sec', lastActiveAt: 2 } },
    };
    openSecretary();
    expect(h.selectConversation).toHaveBeenCalledWith('a');
    expect(h.openWelcome).not.toHaveBeenCalled();
  });

  it('开关没开、Main 还没登记秘书项目时什么都不做', () => {
    h.secretary = { profile: null, projectId: null };
    openSecretary();
    expect(h.openWelcome).not.toHaveBeenCalled();
    expect(h.newSecretaryConversation).not.toHaveBeenCalled();
  });
});
