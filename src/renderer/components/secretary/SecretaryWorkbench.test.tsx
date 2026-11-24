import type { FeedEvent } from '@shared/secretary/feed';
import type { SecretaryBoard, SecretaryCard } from '@shared/types/secretary';
import { parseHTML } from 'linkedom';
import { act, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  board: null as unknown as SecretaryBoard,
  feed: [] as FeedEvent[],
  calls: [] as { name: string; args: unknown }[],
}));

vi.mock('@/i18n', () => ({
  useI18n: () => ({
    t: (key: string, params?: Record<string, string | number>) =>
      params
        ? key.replace(/\{\{(\w+)\}\}/g, (_, token: string) => String(params[token] ?? ''))
        : `[${key}]`,
    locale: 'zh',
  }),
}));
vi.mock('@/stores/settings', () => {
  const state = { projects: [{ id: 'p-sec', kind: 'secretary' }] };
  const useSettingsStore = (selector: (s: unknown) => unknown) => selector(state);
  useSettingsStore.getState = () => state;
  return { useSettingsStore };
});
vi.mock('@/stores/sessions', () => {
  const state = {
    activeId: 'sec',
    conversations: { sec: { projectId: 'p-sec' }, c1: { projectId: 'p1' } },
    selectConversation: (id: string) => h.calls.push({ name: 'selectConversation', args: id }),
  };
  const useSessionsStore = (selector: (s: Record<string, unknown>) => unknown) => selector(state);
  useSessionsStore.getState = () => state;
  useSessionsStore.subscribe = () => () => undefined;
  return { useSessionsStore };
});
vi.mock('@/stores/secretary', () => ({
  focusedSecretaryId: () => undefined,
  useSecretaryStore: (selector: (state: unknown) => unknown) =>
    selector({ secretary: { board: h.board }, secretaries: [], states: {}, focusedId: null }),
}));

const { SecretaryWorkbench } = await import('./SecretaryWorkbench');
const { useSecretaryReturn } = await import('@/stores/secretaryReturn');

const NOW = new Date(2024, 4, 15, 15, 0).getTime();

const sessionCard = (
  over: Partial<Extract<SecretaryCard, { kind: 'session' }>> = {}
): SecretaryCard => ({
  kind: 'session',
  conversationId: 'c1',
  projectId: 'p1',
  projectName: 'enso-code',
  title: '写 hello.txt',
  state: 'error',
  startedAt: NOW - 60_000,
  stateSince: NOW - 60_000,
  secretaryConversationId: 'sec',
  ...over,
});

const board = (needsYou: SecretaryCard[]): SecretaryBoard => ({
  needsYou,
  running: [],
  todos: [],
  done: [],
});

const feedEvent = (over: Partial<FeedEvent> = {}): FeedEvent => ({
  id: 'session:c1',
  at: NOW - 1000,
  tone: 'run',
  projectName: 'enso-code',
  title: '写 hello.txt',
  label: 'Started',
  conversationId: 'c1',
  running: true,
  ...over,
});

let root: Root;
let container: HTMLElement;

async function render(node: ReactElement) {
  await act(async () => {
    root.render(node);
  });
}

const dismissButton = () => container.querySelector('[data-enso="secretary-dismiss-result"]');

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  const dom = parseHTML('<html><body><div id="root"></div></body></html>');
  vi.stubGlobal('window', dom.window);
  vi.stubGlobal('document', dom.document);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  h.calls = [];
  useSecretaryReturn.setState({ back: null });
  h.board = board([]);
  h.feed = [];
  (dom.window as unknown as Record<string, unknown>).electronAPI = {
    secretary: {
      list: async () => [],
      onListChanged: () => () => {},
      dismissResult: async (conversationId: string) => {
        h.calls.push({ name: 'dismissResult', args: conversationId });
        return { ok: true };
      },
      dismissPending: async (pendingId: string) => {
        h.calls.push({ name: 'dismissPending', args: pendingId });
        return { ok: true };
      },
      feed: async () => ({ ok: true, events: h.feed, hasMore: false }),
      onStateChanged: () => () => {},
    },
    agent: {
      abort: async (conversationId: string, options?: unknown) => {
        h.calls.push({ name: 'abort', args: [conversationId, options] });
      },
    },
  };
  container = dom.document.getElementById('root') as unknown as HTMLElement;
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('SecretaryWorkbench 结果卡', () => {
  it('失败结果的卡给「知道了」，点了交给 Main 清掉', async () => {
    h.board = board([sessionCard({ result: 'failed' })]);
    await render(<SecretaryWorkbench name="小安" />);
    const button = dismissButton();
    expect(button?.textContent).toBe('[Got it]');
    act(() => {
      (button as unknown as HTMLElement).click();
    });
    expect(h.calls).toContainEqual({ name: 'dismissResult', args: 'c1' });
  });

  it('实时审批的卡不给「知道了」，清了也不会消失', async () => {
    h.board = board([sessionCard({ state: 'waiting', result: 'needs-user' })]);
    await render(<SecretaryWorkbench name="小安" />);
    expect(container.querySelector('[data-enso="secretary-needs-you"]')).not.toBeNull();
    expect(dismissButton()).toBeNull();
    const cardEl = container.querySelector('[data-enso="secretary-card"]');
    expect(cardEl?.getAttribute('data-tone')).not.toBe('decision');
    expect(cardEl?.textContent).toContain('[Waiting for you]');
  });

  it('goal-complete 且带 needsUser 的卡：中性标签「完成 · 需要你」、summary 灰字、每条「需要你：」前缀，不显示正文噪声', async () => {
    const longNeed = '请确认是否在宿主发版后合并并上架插件 #62，并同步更新仓库发布说明';
    h.board = board([
      sessionCard({
        state: 'idle',
        result: 'goal-complete',
        lastText: '- | | PR 拆分方式 | 合并为 1 个 PR，内部按插件拆成 ...',
        summary: 'relay 已部署到 59dc0c231',
        needsUser: ['是否合并上架 #62', longNeed],
      }),
    ]);
    await render(<SecretaryWorkbench name="小安" />);
    const cardEl = container.querySelector('[data-enso="secretary-card"]');
    expect(cardEl).not.toBeNull();
    expect(cardEl?.getAttribute('data-tone')).toBe('decision');
    expect(cardEl?.className).not.toContain('border-warning');
    expect(cardEl?.textContent).toContain('[Done · needs you]');
    expect(cardEl?.textContent).not.toContain('[Goal complete]');
    expect(cardEl?.textContent).not.toContain('PR 拆分方式');
    expect(
      container.querySelector('[data-enso="secretary-card-needs-user-summary"]')?.textContent
    ).toBe('relay 已部署到 59dc0c231');
    const needItems = Array.from(
      container.querySelectorAll('[data-enso="secretary-card-needs-user-item"]')
    );
    expect(needItems.map((el) => el.textContent)).toEqual([
      'Needs you: 是否合并上架 #62',
      `Needs you: ${longNeed}`,
    ]);
    expect(needItems[1]?.getAttribute('title')).toBe(longNeed);
    const button = dismissButton();
    expect(button?.textContent).toBe('[Got it]');
    act(() => {
      (button as unknown as HTMLElement).click();
    });
    expect(h.calls).toContainEqual({ name: 'dismissResult', args: 'c1' });
  });

  it('needsUser 还在等秘书筛选的卡：收在「秘书处理中 · N」里，展开才看到条目，不计入「需要你」', async () => {
    h.board = {
      ...board([]),
      done: [
        sessionCard({
          state: 'idle',
          result: 'goal-complete',
          triage: true,
          needsUser: ['删临时文件'],
        }),
      ],
    };
    await render(<SecretaryWorkbench name="小安" />);
    expect(container.querySelector('[data-enso="secretary-needs-you"]')).toBeNull();
    const toggle = container.querySelector('[data-enso="secretary-triage-toggle"]');
    expect(toggle?.textContent).toContain('· 1');
    expect(container.querySelector('[data-enso="secretary-triage-item"]')).toBeNull();
    act(() => {
      (toggle as unknown as HTMLElement).click();
    });
    expect(container.querySelector('[data-enso="secretary-triage-item"]')?.textContent).toBe(
      '删临时文件'
    );
    const stats = container.querySelector('[data-enso="secretary-stats"]');
    expect(stats?.textContent).toContain('0');
  });

  it('等审批的会话进「需要你」只因审批；它完成结果里的 needsUser 仍算在「秘书处理中」', async () => {
    h.board = board([
      sessionCard({
        state: 'waiting',
        result: 'goal-complete',
        triage: true,
        needsUser: ['删临时文件'],
      }),
    ]);
    await render(<SecretaryWorkbench name="小安" />);
    const needs = container.querySelector('[data-enso="secretary-needs-you"]');
    expect(needs?.querySelectorAll('[data-enso="secretary-card"]')).toHaveLength(1);
    expect(needs?.textContent).toContain('[Waiting for you]');
    expect(needs?.textContent).not.toContain('[Done · with secretary]');
    expect(needs?.querySelector('[data-enso="secretary-card-needs-user-item"]')).toBeNull();
    const toggle = container.querySelector('[data-enso="secretary-triage-toggle"]');
    expect(toggle?.textContent).toContain('· 1');
  });

  it('「打开会话」跳过去后，目标会话给返回秘书', async () => {
    h.board = board([sessionCard({ result: 'failed' })]);
    await render(<SecretaryWorkbench name="小安" />);
    act(() => {
      (container.querySelector('[data-enso="secretary-card-open"]') as HTMLElement).click();
    });
    expect(h.calls).toContainEqual({ name: 'selectConversation', args: 'c1' });
    expect(useSecretaryReturn.getState().back).toEqual({ from: 'sec', to: 'c1' });
  });

  it('在跑的卡没有结果，不给「知道了」', async () => {
    h.board = board([sessionCard({ state: 'running' })]);
    await render(<SecretaryWorkbench name="小安" />);
    expect(dismissButton()).toBeNull();
  });

  it('工作台不展示对象认领，即使状态里还带着认领', async () => {
    h.board = {
      ...board([sessionCard()]),
      claims: [
        {
          key: 'github:acme/app#1:closed',
          sessionId: 'c1',
          sessionTitle: '写 hello.txt',
          pluginId: 'enso.github',
          label: 'PR 审查',
          claimedAt: NOW - 60_000,
          lastHeartbeatAt: NOW - 5_000,
          active: true,
        },
      ],
    } as SecretaryBoard;
    await render(<SecretaryWorkbench name="小安" />);
    expect(container.querySelector('[data-enso="secretary-claims"]')).toBeNull();
    expect(container.textContent).not.toContain('github:acme/app#1:closed');
    expect(container.textContent).not.toContain('PR 审查');
  });

  it('计数卡下面先是需要你处理，再是进行中，然后才是需求线程、待办和动态', async () => {
    h.board = {
      ...board([sessionCard({ result: 'failed' })]),
      running: [
        sessionCard({ conversationId: 'r1', title: '在跑一', state: 'running' }),
        sessionCard({ conversationId: 'r2', title: '在跑二', state: 'running' }),
      ],
      threads: [
        {
          id: 'dt-1',
          channel: 'telegram',
          chatId: '-100',
          messageId: '42',
          summary: '修登录',
          requesterIsOwner: true,
          sessionId: 'c1',
          sessionTitle: '写 hello.txt',
          status: 'open',
          milestones: [],
          createdAt: NOW - 1000,
          updatedAt: NOW - 1000,
        },
      ],
    };
    await render(<SecretaryWorkbench name="小安" />);
    const order = Array.from(
      container.querySelectorAll('[data-enso="secretary-workbench"] > [data-enso]')
    ).map((el) => el.getAttribute('data-enso'));
    expect(order).toEqual([
      'secretary-stats',
      'secretary-needs-you',
      'secretary-workbench-running',
      'secretary-threads',
      'secretary-todos',
      'secretary-feed',
    ]);
    const running = container.querySelector('[data-enso="secretary-workbench-running"]');
    expect(
      Array.from(running?.querySelectorAll('[data-enso="secretary-running-row"]') ?? []).map((el) =>
        el.getAttribute('data-conversation')
      )
    ).toEqual(['r1', 'r2']);
  });

  it('计数卡的数字等于下面列出的条数', async () => {
    h.board = {
      ...board([
        sessionCard({ conversationId: 'n1', result: 'failed' }),
        sessionCard({ conversationId: 'n2', state: 'waiting', result: 'needs-user' }),
      ]),
      running: [sessionCard({ conversationId: 'r1', state: 'running' })],
      todos: [{ id: 't1', text: '买牛奶', createdAt: NOW - 1000, updatedAt: NOW - 1000 }],
    };
    await render(<SecretaryWorkbench name="小安" />);
    const stat = (target: string) =>
      container.querySelector(`[data-enso="secretary-stat"][data-target="${target}"]`)
        ?.firstElementChild?.textContent;
    expect(stat('needs-you')).toBe(
      String(container.querySelectorAll('[data-enso="secretary-card"]').length)
    );
    expect(stat('needs-you')).toBe('2');
    expect(stat('running')).toBe(
      String(
        container.querySelectorAll(
          '[data-enso="secretary-workbench-running"] [data-enso="secretary-running-row"]'
        ).length
      )
    );
    expect(stat('running')).toBe('1');
    expect(stat('todos')).toBe(
      String(
        container.querySelectorAll('[data-enso="secretary-todos"] [data-enso="secretary-todo"]')
          .length
      )
    );
  });

  it('点计数卡滚到对应列表', async () => {
    h.board = {
      ...board([sessionCard({ result: 'failed' })]),
      running: [sessionCard({ conversationId: 'r1', state: 'running' })],
    };
    await render(<SecretaryWorkbench name="小安" />);
    const targets = {
      'needs-you': 'secretary-needs-you',
      running: 'secretary-workbench-running',
      todos: 'secretary-todos',
    } as const;
    for (const [target, section] of Object.entries(targets)) {
      const node = container.querySelector(`[data-enso="${section}"]`) as unknown as {
        scrollIntoView: (options?: unknown) => void;
      };
      const scrolled = vi.fn();
      node.scrollIntoView = scrolled;
      act(() => {
        (
          container.querySelector(
            `[data-enso="secretary-stat"][data-target="${target}"]`
          ) as HTMLElement
        ).click();
      });
      expect(scrolled).toHaveBeenCalledTimes(1);
    }
  });

  it('有需求线程时列出来源、PR 和负责会话，没有则不显示', async () => {
    h.board = {
      ...board([sessionCard()]),
      threads: [
        {
          id: 'dt-1',
          channel: 'telegram',
          chatId: '-100',
          messageId: '42',
          summary: '修登录',
          requesterIsOwner: true,
          sessionId: 'c1',
          sessionTitle: '写 hello.txt',
          pr: { repo: 'Enso/App', number: 7 },
          status: 'pr_opened',
          milestones: ['pr_opened'],
          createdAt: NOW - 60_000,
          updatedAt: NOW - 5_000,
        },
      ],
    };
    await render(<SecretaryWorkbench name="小安" />);
    const section = container.querySelector('[data-enso="secretary-threads"]');
    expect(section?.textContent).toContain('[Demand threads]');
    expect(section?.textContent).toContain('修登录');
    expect(section?.textContent).toContain('#7');
    expect(section?.textContent).toContain('pr_opened');
    expect(section?.textContent).toContain('写 hello.txt');
    act(() => {
      (container.querySelector('[data-enso="secretary-thread"]') as HTMLElement).click();
    });
    expect(h.calls).toContainEqual({ name: 'selectConversation', args: 'c1' });
    h.board = board([sessionCard()]);
    await render(<SecretaryWorkbench name="小安" />);
    expect(container.querySelector('[data-enso="secretary-threads"]')).toBeNull();
  });
});

describe('SecretaryWorkbench 等依赖的派发出问题', () => {
  const pendingCard = (): SecretaryCard => ({
    kind: 'pending',
    projectName: 'enso-code',
    pending: {
      id: 'pend-1',
      projectId: 'p1',
      secretaryConversationId: 'sec',
      createdAt: NOW - 60_000,
      updatedAt: NOW - 1000,
      status: 'failed',
      problem: 'dependency-failed',
      failedDependency: 'c1',
      after: ['c1'],
      draft: { projectId: 'p1', prompt: '接着改', worktree: false },
    },
  });
  const ignoreButton = () =>
    container.querySelector('[data-enso="secretary-dismiss-pending"]') as HTMLElement | null;

  it('给「忽略」，点了按派发 id 交给 Main 移除', async () => {
    h.board = board([pendingCard()]);
    await render(<SecretaryWorkbench name="小安" />);
    expect(ignoreButton()?.textContent).toBe('[Ignore]');
    act(() => ignoreButton()?.click());
    expect(h.calls).toContainEqual({ name: 'dismissPending', args: 'pend-1' });
    expect(h.calls.some((call) => call.name === 'dismissResult')).toBe(false);
  });

  it('没有会话可开：不给「打开会话」「停止」「知道了」', async () => {
    h.board = board([pendingCard()]);
    await render(<SecretaryWorkbench name="小安" />);
    expect(container.querySelector('[data-enso="secretary-card-open"]')).toBeNull();
    expect(dismissButton()).toBeNull();
    expect(container.textContent).not.toContain('[Stop]');
    expect(container.textContent).not.toContain('[Open session]');
  });

  it('和会话结果卡并排时，结果卡的「知道了」照旧', async () => {
    h.board = board([pendingCard(), sessionCard({ result: 'failed' })]);
    await render(<SecretaryWorkbench name="小安" />);
    act(() => (dismissButton() as unknown as HTMLElement).click());
    expect(h.calls).toContainEqual({ name: 'dismissResult', args: 'c1' });
    expect(ignoreButton()).not.toBeNull();
  });
});

describe('SecretaryWorkbench 动态行：停止与跳转', () => {
  const feedRow = () =>
    container.querySelector('[data-enso="secretary-feed-event"]') as HTMLElement;
  const inRow = (selector: string) => feedRow().querySelector(selector) as HTMLElement | null;
  const layer = () => inRow('[data-slot="hover-actions"]');
  const openButton = () => inRow('[data-enso="secretary-feed-open"]');
  const stopButton = () => inRow('[data-enso="secretary-feed-stop"]');
  const expandButton = () => inRow('[data-enso="secretary-feed-expand"]');

  beforeEach(async () => {
    h.board = {
      needsYou: [],
      running: [sessionCard({ state: 'running' })],
      todos: [],
      done: [],
    };
    h.feed = [feedEvent()];
    await render(<SecretaryWorkbench name="小安" />);
    await act(async () => {});
  });

  it('跳转按钮只有一个，排在行尾且不在蒙版里：悬停时位置不变、盖不住', () => {
    const row = feedRow();
    const opens = row.querySelectorAll('[data-enso="secretary-feed-open"]');
    expect(opens).toHaveLength(1);
    expect(row.lastElementChild).toBe(opens[0]);
    expect(layer()?.contains(opens[0])).toBe(false);
    // 蒙版右侧让出跳转按钮的宽度并留出间距，停止不会落在跳转的位置上
    expect(layer()?.className).toContain('pr-7');
  });

  it('蒙版里只有停止，两个按钮都有 tooltip，停止悬停用危险色', () => {
    const stop = stopButton();
    expect(stop).not.toBeNull();
    expect(layer()?.contains(stop)).toBe(true);
    expect(stop?.getAttribute('title')).toBe('[Stop]');
    expect(stop?.className).toContain('hover:text-destructive');
    expect(openButton()?.getAttribute('title')).toBe('[Open session]');
  });

  it('点跳转只跳转：不停会话，也不展开这一行', async () => {
    act(() => openButton()?.click());
    await act(async () => {});
    expect(h.calls).toContainEqual({ name: 'selectConversation', args: 'c1' });
    expect(useSecretaryReturn.getState().back).toEqual({ from: 'sec', to: 'c1' });
    expect(h.calls.some((call) => call.name === 'abort')).toBe(false);
    expect(expandButton()?.getAttribute('aria-expanded')).toBe('false');
  });

  it('点停止只停止：不跳转，也不展开这一行', async () => {
    act(() => stopButton()?.click());
    await act(async () => {});
    expect(h.calls).toContainEqual({
      name: 'abort',
      args: ['c1', { stopSubagents: true, cancelReminders: true }],
    });
    expect(h.calls.some((call) => call.name === 'selectConversation')).toBe(false);
    expect(expandButton()?.getAttribute('aria-expanded')).toBe('false');
  });
});

describe('SecretaryWorkbench 动态正文', () => {
  const body = () => container.querySelector('[data-enso="secretary-feed-expand"] .line-clamp-2');

  function show(event: FeedEvent) {
    h.board = {
      needsYou: [],
      running: [sessionCard({ state: 'idle', result: 'goal-complete' })],
      todos: [],
      done: [],
    };
    h.feed = [event];
  }

  it('title 是完整的标签和详情', async () => {
    show(
      feedEvent({
        running: false,
        tone: 'ok',
        label: 'Goal complete',
        detail: '是否合并；确认发版',
      })
    );
    await render(<SecretaryWorkbench name="小安" />);
    await act(async () => {});
    expect(body()?.getAttribute('title')).toBe('[Goal complete] · 是否合并；确认发版');
    expect(body()?.textContent).toBe('[Goal complete] · 是否合并；确认发版');
  });

  it('没有详情时 title 只有标签', async () => {
    show(feedEvent({ running: false, tone: 'ok', label: 'Goal complete' }));
    await render(<SecretaryWorkbench name="小安" />);
    await act(async () => {});
    expect(body()?.getAttribute('title')).toBe('[Goal complete]');
    expect(body()?.textContent).toBe('[Goal complete]');
  });
});

describe('SecretaryWorkbench 待办状态与会话状态一致', () => {
  it('运行中的待办只在「进行中」出现、不进「出问题」、不显示红字「会话已停止」', async () => {
    h.board = {
      needsYou: [],
      running: [
        sessionCard({
          conversationId: 'a61340f1',
          title: '监听事件按对象认领 + 需求线程关联表',
          state: 'running',
        }),
      ],
      todos: [
        {
          id: 't1',
          text: '监听事件按组认领 + 需求线程关联表',
          createdAt: 1,
          updatedAt: 2,
          conversationId: 'a61340f1',
          sessionTitle: '监听事件按对象认领 + 需求线程关联表',
          sessionState: 'running',
          phase: 'active',
        },
      ],
      done: [],
    };
    await render(<SecretaryWorkbench name="小安" />);
    await act(async () => {});
    expect(container.querySelector('[data-enso="secretary-problem"]')).toBeNull();
    expect(container.querySelector('[data-enso="secretary-todo-problem"]')).toBeNull();
    const activeRow = container.querySelector('[data-enso="secretary-todo"][data-phase="active"]');
    expect(activeRow?.textContent).toContain('监听事件按组认领 + 需求线程关联表');
    expect(activeRow?.textContent).toContain('[Running]');
  });

  it('真正续跑失败/清单外中断的待办进「出问题」显示「会话已停止」且会话状态为空闲', async () => {
    h.board = {
      needsYou: [],
      running: [],
      todos: [
        {
          id: 't2',
          text: '未写入恢复清单的待办',
          createdAt: 1,
          updatedAt: 2,
          conversationId: 'c2',
          sessionTitle: '崩溃会话',
          sessionState: 'idle',
          problem: 'stopped',
          phase: 'problem',
        },
      ],
      done: [
        sessionCard({
          conversationId: 'c2',
          title: '崩溃会话',
          state: 'idle',
          result: 'interrupted',
        }),
      ],
    };
    await render(<SecretaryWorkbench name="小安" />);
    await act(async () => {});
    const problemGroup = container.querySelector('[data-enso="secretary-problem"]');
    expect(problemGroup).not.toBeNull();
    const problemText = problemGroup?.querySelector('[data-enso="secretary-todo-problem"]');
    expect(problemText?.textContent).toBe('[The session was stopped]');
    const sessionLine = problemGroup?.querySelector('[data-enso="secretary-todo-session"]');
    expect(sessionLine?.textContent).toContain('[Idle]');
    expect(sessionLine?.textContent).not.toContain('[Running]');
  });
});
