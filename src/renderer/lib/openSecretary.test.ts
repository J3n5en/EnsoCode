import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  secretary: { profile: null as unknown, projectId: 'sec' as string | null },
  secretaries: [] as { id: string; projectId: string | null; name?: string | null }[],
  states: {} as Record<string, { profile: unknown; projectId: string | null }>,
  focusedId: null as string | null,
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
  focusedSecretaryId: () => undefined,
  useSecretaryStore: {
    getState: () => ({
      secretary: h.secretary,
      secretaries: h.secretaries,
      states: h.states,
      focusedId: h.focusedId,
      focus: (id: string) => {
        h.focusedId = id;
      },
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
    h.secretaries = [{ id: 'default', projectId: 'sec' }];
    h.states = { default: h.secretary };
    h.focusedId = 'default';
    h.sessions = { order: [], conversations: {} };
    h.openWelcome.mockClear();
    h.newSecretaryConversation.mockClear();
    h.selectConversation.mockClear();
  });

  it('还没设置过、也没有会话时进欢迎页', () => {
    h.states = { default: h.secretary };
    openSecretary();
    expect(h.openWelcome).toHaveBeenCalledTimes(1);
    expect(h.newSecretaryConversation).not.toHaveBeenCalled();
  });

  it('已设置时打开最近活跃的秘书会话', () => {
    h.secretary = { profile: { name: '秘书' }, projectId: 'sec' };
    h.states = { default: h.secretary };
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
    h.states = { default: h.secretary };
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
    h.secretaries = [];
    h.states = {};
    h.focusedId = null;
    openSecretary();
    expect(h.openWelcome).not.toHaveBeenCalled();
    expect(h.newSecretaryConversation).not.toHaveBeenCalled();
  });
});

it('多个秘书时打开最近用过的那个秘书的最近会话', () => {
  h.secretaries = [
    { id: 'default', projectId: 'sec' },
    { id: 's-two', projectId: 'sec-2' },
  ];
  h.states = {
    default: { profile: { name: '小安' }, projectId: 'sec' },
    's-two': { profile: { name: '阿财' }, projectId: 'sec-2' },
  };
  h.sessions = {
    order: ['a', 'b'],
    conversations: {
      a: { projectId: 'sec', lastActiveAt: 1 },
      b: { projectId: 'sec-2', lastActiveAt: 9 },
    },
  };
  openSecretary();
  expect(h.focusedId).toBe('s-two');
  expect(h.selectConversation).toHaveBeenCalledWith('b');
});

it('刚建好的秘书状态还没到时，按清单判断：没档案就进欢迎页，不是什么都不做', () => {
  h.secretaries = [
    { id: 'default', projectId: 'sec', name: '小安' },
    { id: 's-new', projectId: 'sec-new', name: null },
  ];
  h.states = { default: { profile: { name: '小安' }, projectId: 'sec' } };
  h.sessions = { order: [], conversations: {} };
  h.openWelcome.mockClear();
  openSecretary('s-new');
  expect(h.focusedId).toBe('s-new');
  expect(h.openWelcome).toHaveBeenCalledTimes(1);
  expect(h.newSecretaryConversation).not.toHaveBeenCalled();
});

it('点击事件误传进来时不当成秘书 id，仍打开当前秘书', () => {
  h.secretary = { profile: { name: '秘书' }, projectId: 'sec' };
  h.states = { default: h.secretary };
  h.focusedId = 'default';
  h.sessions = {
    order: ['a'],
    conversations: { a: { projectId: 'sec', lastActiveAt: 3 } },
  };
  openSecretary({ type: 'click' } as unknown as string);
  expect(h.focusedId).toBe('default');
  expect(h.selectConversation).toHaveBeenCalledWith('a');
});
