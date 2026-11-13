import type { SecretaryBoard, SecretaryCard, SecretaryProposal } from '@shared/types/secretary';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  board: null as unknown as SecretaryBoard,
  proposals: {} as Record<string, SecretaryProposal>,
}));

vi.mock('@/i18n', () => ({ useI18n: () => ({ t: (key: string) => `[${key}]` }) }));
vi.mock('@/stores/settings', () => ({
  useSettingsStore: (
    selector: (state: { projects: { id: string; name: string; path: string }[] }) => unknown
  ) => selector({ projects: [{ id: 'p1', name: 'enso', path: '/p/enso' }] }),
}));
vi.mock('@/stores/sessions', () => ({
  useSessionsStore: (selector: (state: { conversations: Record<string, unknown> }) => unknown) =>
    selector({ conversations: {} }),
}));
vi.mock('@/stores/secretary', () => ({
  useSecretaryStore: (selector: (state: unknown) => unknown) =>
    selector({
      secretary: { board: h.board, proposals: h.proposals },
      resolving: {},
      resolveProposal: () => undefined,
    }),
}));

const { boardGroups, SecretaryBoardPanel } = await import('./SecretaryBoardPanel');

const sessionCard = (
  conversationId: string,
  title: string,
  state: 'running' | 'idle' | 'waiting' | 'error' | 'not-started' = 'running'
): SecretaryCard => ({
  kind: 'session',
  conversationId,
  projectId: 'p1',
  projectName: 'enso',
  title,
  state,
  lastText: `${title} 的最后一句`,
  startedAt: Date.now() - 12 * 60_000,
  secretaryConversationId: 'sec1',
});

const proposalCard: SecretaryCard = {
  kind: 'proposal',
  proposal: {
    id: 'pr1',
    secretaryConversationId: 'sec1',
    createdAt: 1,
    updatedAt: 1,
    status: 'pending',
    kind: 'dispatch',
    draft: { projectId: 'p1', prompt: '重构登录流程', worktree: false },
  },
};

const board = (over: Partial<SecretaryBoard> = {}): SecretaryBoard => ({
  needsYou: [],
  running: [],
  todos: [],
  done: [],
  ...over,
});

describe('boardGroups', () => {
  it('分组顺序固定：需要你处理置顶，已完成最后且默认折叠', () => {
    const groups = boardGroups(board());
    expect(groups.map((group) => group.key)).toEqual(['needsYou', 'running', 'todos', 'done']);
    expect(groups.map((group) => group.title)).toEqual([
      'Waiting on you',
      'In progress',
      'To do',
      'Completed',
    ]);
    expect(groups.filter((group) => group.collapsible).map((group) => group.key)).toEqual(['done']);
  });

  it('卡片与待办各归各组', () => {
    const groups = boardGroups(
      board({
        needsYou: [proposalCard],
        running: [sessionCard('c1', '修登录')],
        todos: [{ id: 't1', text: '写周报', createdAt: 1, updatedAt: 1 }],
        done: [sessionCard('c2', '升级 Astro', 'idle')],
      })
    );
    const byKey = Object.fromEntries(groups.map((group) => [group.key, group]));
    expect(byKey.needsYou.cards.map((card) => card.kind)).toEqual(['proposal']);
    expect(byKey.running.cards.map((card) => card.kind)).toEqual(['session']);
    expect(byKey.todos.todos.map((todo) => todo.id)).toEqual(['t1']);
    expect(byKey.done.cards).toHaveLength(1);
  });
});

describe('SecretaryBoardPanel', () => {
  it('进行中的卡片显示项目、标题、最后一句与打开/停止', () => {
    h.board = board({ running: [sessionCard('c1', '修登录')] });
    const html = renderToStaticMarkup(createElement(SecretaryBoardPanel));
    expect(html).toContain('[In progress]');
    expect(html).toContain('修登录');
    expect(html).toContain('修登录 的最后一句');
    expect(html).toContain('enso');
    expect(html).toContain('[Open]');
    expect(html).toContain('[Stop]');
  });

  it('待确认的派活复用聊天卡片，就地确认', () => {
    h.proposals = { pr1: (proposalCard as Extract<SecretaryCard, { kind: 'proposal' }>).proposal };
    h.board = board({ needsYou: [proposalCard] });
    const html = renderToStaticMarkup(createElement(SecretaryBoardPanel));
    expect(html).toContain('[Waiting on you]');
    expect(html).toContain('重构登录流程');
    expect(html).toContain('[Confirm dispatch]');
    expect(html).toContain('[Reject]');
  });

  it('已完成默认折叠，只留分组标题与条数', () => {
    h.proposals = {};
    h.board = board({ done: [sessionCard('c2', '升级 Astro', 'idle')] });
    const html = renderToStaticMarkup(createElement(SecretaryBoardPanel));
    expect(html).toContain('[Completed]');
    expect(html).not.toContain('升级 Astro');
  });

  it('待办显示文字与派出/编辑/删除', () => {
    h.board = board({ todos: [{ id: 't1', text: '写周报', createdAt: 1, updatedAt: 1 }] });
    const html = renderToStaticMarkup(createElement(SecretaryBoardPanel));
    expect(html).toContain('写周报');
    expect(html).toContain('[Dispatch]');
    expect(html).toContain('[Edit]');
    expect(html).toContain('[Delete]');
  });
});
