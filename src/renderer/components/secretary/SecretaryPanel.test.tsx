import { feedEvents, pageFeed } from '@shared/secretary/feed';
import type { SecretaryBoard, SecretaryCard, SecretaryProposal } from '@shared/types/secretary';
import { parseHTML } from 'linkedom';
import { act, createElement, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const translate = (key: string, params?: Record<string, string | number>) =>
  params
    ? key.replace(/\{\{(\w+)\}\}/g, (_, token: string) => String(params[token] ?? ''))
    : `[${key}]`;

const h = vi.hoisted(() => ({
  board: null as unknown as SecretaryBoard,
  calls: [] as { name: string; args: unknown }[],
  schedules: [] as Record<string, unknown>[],
  stateListeners: [] as (() => void)[],
  // 稳定引用：真实 store 只在推送时换对象，每次渲染新建会让订阅它的 effect 反复触发
  secretary: {} as Record<string, unknown>,
}));

vi.mock('@/i18n', () => ({ useI18n: () => ({ t: translate, locale: 'zh' }) }));
vi.mock('@/plugins/PluginIcon', () => ({ PluginIcon: () => null }));
vi.mock('@/plugins/PluginView', () => ({ PluginFrame: () => null }));
vi.mock('qrcode', () => ({ default: { toDataURL: async () => '' } }));
vi.mock('@/components/ui/switch', () => ({
  Switch: ({
    checked,
    onCheckedChange,
    className: _className,
    ...rest
  }: { checked?: boolean; onCheckedChange?: (value: boolean) => void; className?: string } & Record<
    string,
    unknown
  >) => (
    <button
      type="button"
      role="switch"
      aria-checked={checked === true}
      onClick={() => onCheckedChange?.(checked !== true)}
      {...rest}
    />
  ),
}));
vi.mock('@/stores/settings', () => ({
  useSettingsStore: (selector: (state: { projects: unknown[] }) => unknown) =>
    selector({ projects: [] }),
}));
vi.mock('@/stores/sessions', () => {
  const state = {
    conversations: { c1: { projectId: 'p1' } },
    selectConversation: (id: string) => h.calls.push({ name: 'selectConversation', args: id }),
  };
  const useSessionsStore = (selector: (s: Record<string, unknown>) => unknown) => selector(state);
  useSessionsStore.getState = () => state;
  useSessionsStore.subscribe = () => () => undefined;
  return { useSessionsStore };
});
vi.mock('@/stores/secretary', () => ({
  focusedSecretaryId: () => undefined,
  secretaryIdOfProject: () => null,
  useSecretaryStore: (selector: (state: unknown) => unknown) =>
    selector({
      secretary: h.secretary,
      secretaries: [],
      states: {},
      focusedId: null,
      resolving: {},
      resolveProposal: () => undefined,
      reload: (secretaryId?: string) => h.calls.push({ name: 'reload', args: secretaryId }),
    }),
}));

const { SecretaryPanel } = await import('./SecretaryPanel');
const { useSessionPeek } = await import('@/stores/sessionPeek');
const { SecretaryRunningList } = await import('./SecretaryRunningList');

const NOW = new Date(2024, 4, 15, 15, 0).getTime();

const sessionCard = (
  conversationId: string,
  over: Partial<Extract<SecretaryCard, { kind: 'session' }>> = {}
): SecretaryCard => ({
  kind: 'session',
  conversationId,
  projectId: 'p1',
  projectName: 'enso-code',
  title: `任务 ${conversationId}`,
  state: 'running',
  startedAt: NOW - 60_000,
  stateSince: NOW - 60_000,
  secretaryConversationId: 'sec',
  ...over,
});

const proposalCard: SecretaryCard = {
  kind: 'proposal',
  projectName: 'enso-code',
  proposal: {
    id: 'pr1',
    secretaryConversationId: 'sec',
    createdAt: NOW - 30_000,
    updatedAt: NOW - 30_000,
    status: 'pending',
    kind: 'dispatch',
    draft: { projectId: 'p1', prompt: '重构登录流程', worktree: false },
  } as SecretaryProposal,
};

const board = (over: Partial<SecretaryBoard> = {}): SecretaryBoard => ({
  needsYou: [],
  running: [],
  todos: [],
  done: [],
  ...over,
});

let root: Root;
let container: HTMLElement;

async function render(node: ReactElement) {
  await act(async () => {
    root.render(node);
  });
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
  });
}

function click(selector: string) {
  const node = container.querySelector(selector);
  expect(node, selector).not.toBeNull();
  act(() => {
    (node as unknown as HTMLElement).click();
  });
}

function text(selector: string): string {
  return container.querySelector(selector)?.textContent ?? '';
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  const dom = parseHTML('<html><body><div id="root"></div></body></html>');
  vi.stubGlobal('window', dom.window);
  vi.stubGlobal('document', dom.document);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  h.calls = [];
  h.stateListeners = [];
  useSessionPeek.setState({ conversationId: null, from: null });
  h.schedules = [
    {
      id: 's1',
      name: '每日晨报',
      prompt: '简报',
      cron: '0 9 * * *',
      nextRunAt: NOW + 3_600_000,
      system: 'daily-brief' as const,
    },
    {
      id: 's2',
      name: '每周五汇总',
      prompt: '汇总',
      cron: '0 18 * * 5',
      nextRunAt: NOW + 86_400_000,
    },
  ];
  h.board = board();
  h.secretary = {
    enabled: true,
    projectId: 'sec',
    profile: {
      version: 1,
      name: '小安',
      avatar: { color: '#8b7bff' },
      visibleProjectIds: 'all',
      maxRunningDispatches: 3,
      replyLanguage: 'ui',
      style: 'concise',
      notify: 'needs-user',
      updatedAt: 1,
    },
    persona: '',
    board: h.board,
    proposals: { pr1: proposalCard.proposal },
  };
  const api = {
    secretary: {
      list: async () => [],
      onListChanged: () => () => {},
      listSchedules: async () => ({ ok: true, schedules: structuredClone(h.schedules) }),
      onStateChanged: (listener: () => void) => {
        h.stateListeners.push(listener);
        return () => {
          h.stateListeners = h.stateListeners.filter((entry) => entry !== listener);
        };
      },
      removeSchedule: async (id: string) => {
        h.calls.push({ name: 'removeSchedule', args: id });
        return { ok: true };
      },
      mutateTodo: async (request: unknown) => {
        h.calls.push({ name: 'mutateTodo', args: request });
        return { ok: true, todoId: 't1' };
      },
      markResult: async (conversationId: string, action: string) => {
        h.calls.push({ name: 'markResult', args: [conversationId, action] });
        return { ok: true };
      },
      feed: async (query?: { before?: { at: number; id: string }; limit?: number }) => {
        const page = pageFeed(feedEvents(h.secretary.board as SecretaryBoard), query ?? {});
        return { ok: true, ...page };
      },
      contactState: async () => ({
        enabled: true,
        channels: [
          {
            id: 'telegram',
            title: 'Telegram',
            builtin: true,
            status: 'connected',
            caps: {
              buttons: true,
              urlButtons: true,
              edit: true,
              typing: true,
              format: 'html',
              maxChars: 4096,
              commandMenu: true,
              images: true,
              files: true,
            },
            prefs: {
              enabled: true,
              push: true,
              cardConfirm: true,
              syncMirror: false,
              memory: false,
            },
          },
        ],
        telegram: {
          status: 'bound',
          chat: { id: 777, username: 'j3n5en' },
          bot: { id: 42, username: 'enso_bot', name: 'Enso' },
          allowCardConfirm: true,
          allowMemory: false,
          syncMirror: false,
          groups: [],
          following: [],
          poll: { state: 'running' },
          secure: true,
        },
        owner: { githubLogins: ['j3n5en'], externalConfirm: false },
      }),
      onContactChanged: () => () => {},
      contactGithubSuggest: async () => ({ login: null }),
    },
    extensionPlugins: {
      list: async () => [],
      onChanged: () => () => {},
    },
    memory: {
      list: async () => ({ items: [] }),
      onChanged: () => () => {},
      detail: async () => null,
      update: async () => ({ ok: true }),
      archive: async () => ({ ok: true }),
      delete: async () => ({ ok: true }),
    },
    agent: {
      abort: async (id: string, options?: unknown) => {
        h.calls.push({ name: 'abort', args: [id, options] });
      },
      respondApproval: async () => ({ ok: true }),
      respondAsk: async () => ({ ok: true }),
    },
  };
  (dom.window as unknown as Record<string, unknown>).electronAPI = api;
  container = dom.document.getElementById('root') as unknown as HTMLElement;
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('SecretaryPanel', () => {
  it('秘书状态是 enabled=false 时不留白：显示读取提示、自动重读，可手动重试', async () => {
    h.secretary = {
      enabled: false,
      projectId: null,
      profile: null,
      persona: '',
      board: board(),
      proposals: {},
      takeovers: [],
    };
    await render(<SecretaryPanel />);
    await flush();
    expect(container.textContent).toContain('[Loading secretary…]');
    expect(h.calls.filter((call) => call.name === 'reload')).toHaveLength(1);
    click('[data-enso="secretary-panel-reload"]');
    expect(h.calls.filter((call) => call.name === 'reload')).toHaveLength(2);
  });

  it('顶部显示名字与一行摘要，并留设置入口', async () => {
    h.board = h.secretary.board = board({
      needsYou: [proposalCard],
      running: [sessionCard('c1')],
    });
    await render(<SecretaryPanel />);
    await flush();
    expect(text('[data-enso="secretary-panel"]')).toContain('小安');
    expect(text('[data-enso="secretary-summary"]')).toBe('1 waiting · 1 running');
    expect(container.querySelector('[data-enso="secretary-panel-settings"]')).not.toBeNull();
  });

  it('工作台默认打开：问候、今日战报、三个计数与等你卡', async () => {
    h.board = h.secretary.board = board({
      needsYou: [proposalCard],
      running: [sessionCard('c1')],
      todos: [{ id: 't1', text: '写周报', createdAt: NOW, updatedAt: NOW }],
      done: [sessionCard('c2', { state: 'idle', result: 'goal-complete', resultAt: NOW - 30_000 })],
    });
    await render(<SecretaryPanel />);
    await flush();
    const workbench = container.querySelector('[data-enso="secretary-workbench"]');
    expect(workbench?.textContent).toContain('[Good afternoon]');
    expect(workbench?.textContent).toContain('Today 2 dispatched, 1 completed, 0 failed');
    const stats = [...container.querySelectorAll('[data-enso="secretary-stat"]')];
    expect(stats.map((node) => node.textContent)).toEqual([
      '1[Waiting on you]',
      '1[In progress]',
      '1[To do]',
    ]);
    expect(stats[0].getAttribute('data-warn')).toBe('true');
    expect(container.querySelector('[data-enso="secretary-needs-you"]')?.textContent).toContain(
      '重构登录流程'
    );
    expect(container.querySelector('[data-enso="secretary-needs-you"]')?.textContent).toContain(
      '[Confirm dispatch]'
    );
  });

  it('今日战报：之前派出或接手的完成另起一句，不混进今天派出的完成数', async () => {
    h.board = h.secretary.board = board({
      done: [
        sessionCard('today', { state: 'idle', result: 'goal-complete', resultAt: NOW - 30_000 }),
        sessionCard('old', {
          state: 'idle',
          startedAt: NOW - 86_400_000,
          result: 'goal-complete',
          resultAt: NOW - 20_000,
        }),
      ],
    });
    await render(<SecretaryPanel />);
    await flush();
    expect(text('[data-enso="secretary-workbench"]')).toContain(
      'Today 1 dispatched, 1 completed, 0 failed; plus 1 earlier or taken over completed'
    );
  });

  it('今天没派新活但完成了之前的，不说「还没派活」', async () => {
    h.board = h.secretary.board = board({
      done: [
        sessionCard('old', {
          state: 'idle',
          startedAt: NOW - 86_400_000,
          result: 'goal-complete',
          resultAt: NOW - 20_000,
        }),
      ],
    });
    await render(<SecretaryPanel />);
    await flush();
    expect(text('[data-enso="secretary-workbench"]')).toContain(
      'No new dispatches today; 1 earlier or taken over completed'
    );
  });

  it('全空时给空状态与记一条待办入口', async () => {
    await render(<SecretaryPanel />);
    await flush();
    const empty = container.querySelector('[data-enso="secretary-empty"]');
    expect(empty?.textContent).toContain('[Nothing on your plate]');
    expect(empty?.textContent).toContain('Ask 小安 for work in the chat, or note a to-do first');
    click('[data-enso="secretary-empty"] button');
    expect(container.querySelector('[data-enso="secretary-empty"]')).toBeNull();
    expect(container.querySelector('input')).not.toBeNull();
  });

  it('动态列出在跑的会话，hover 的停止按钮真的中止会话', async () => {
    h.board = h.secretary.board = board({ running: [sessionCard('c1', { title: '跑全量测试' })] });
    await render(<SecretaryPanel />);
    await flush();
    const feed = container.querySelector('[data-enso="secretary-feed"]');
    expect(feed?.textContent).toContain('跑全量测试');
    expect(feed?.textContent).toContain('[Started]');
    click('[data-enso="secretary-feed-event"] button[aria-label="[Stop]"]');
    await flush();
    expect(h.calls).toContainEqual({
      name: 'abort',
      args: ['c1', { stopSubagents: true, cancelReminders: true }],
    });
  });

  it('动态行点主体只展开，右侧图标才打开会话', async () => {
    h.board = h.secretary.board = board({
      running: [sessionCard('c1', { title: '跑全量测试', lastText: '第 3 步' })],
    });
    await render(<SecretaryPanel />);
    await flush();
    const expand = () => container.querySelector('[data-enso="secretary-feed-expand"]');
    expect(expand()?.getAttribute('aria-expanded')).toBe('false');
    click('[data-enso="secretary-feed-expand"]');
    expect(expand()?.getAttribute('aria-expanded')).toBe('true');
    expect(h.calls).not.toContainEqual({ name: 'selectConversation', args: 'c1' });
    click('[data-enso="secretary-feed-open"]');
    expect(h.calls).toContainEqual({ name: 'selectConversation', args: 'c1' });
    expect(expand()?.getAttribute('aria-expanded')).toBe('true');
  });

  it('待办、动态、定时的行内操作都叠在悬停蒙版里，不占行宽', async () => {
    h.board = h.secretary.board = board({
      running: [sessionCard('c1', { title: '跑全量测试' })],
      todos: [{ id: 't1', text: '写周报', createdAt: NOW, updatedAt: NOW }],
    });
    await render(<SecretaryPanel />);
    await flush();
    const layered = (rowSelector: string, labels: string[]) => {
      const row = container.querySelector(rowSelector) as HTMLElement;
      expect(row.className).toContain('group/row');
      expect(row.className).toContain('relative');
      const layer = row.querySelector('[data-slot="hover-actions"]') as HTMLElement;
      expect(layer.className).toContain('absolute');
      expect(layer.className).toContain('opacity-0');
      const inLayer = [...layer.querySelectorAll('button')].map((b) =>
        b.getAttribute('aria-label')
      );
      expect(inLayer).toEqual(labels);
      // 蒙版外不再有操作按钮占位
      const outside = [...row.querySelectorAll('button')].filter((b) => !layer.contains(b));
      expect(outside.every((b) => !labels.includes(b.getAttribute('aria-label') ?? ''))).toBe(true);
    };
    layered('[data-enso="secretary-todo"]', ['[Dispatch]', '[Edit]', '[Delete]']);
    layered('[data-enso="secretary-feed-event"]', ['[Stop]']);
    click('[data-enso="secretary-panel-tab"][data-tab="schedules"]');
    await flush();
    const rows = container.querySelectorAll('[data-enso="secretary-schedule"]');
    expect(rows[0].querySelector('[data-slot="hover-actions"]')).toBeNull();
    rows[1].setAttribute('data-probe', 'own');
    layered('[data-probe="own"]', ['[Delete]']);
  });

  it('点圆形勾选框把待办标记完成', async () => {
    h.board = h.secretary.board = board({
      todos: [{ id: 't1', text: '写周报', createdAt: NOW, updatedAt: NOW }],
    });
    await render(<SecretaryPanel />);
    await flush();
    click('[data-enso="secretary-todo-done"]');
    expect(h.calls).toContainEqual({
      name: 'mutateTodo',
      args: { action: 'update', todoId: 't1', done: true },
    });
  });

  it('进行中的待办显示会话并可放回待办', async () => {
    h.board = h.secretary.board = board({
      todos: [
        {
          id: 't1',
          text: '看构建',
          createdAt: NOW,
          updatedAt: NOW,
          phase: 'active',
          conversationId: 'c9',
          sessionTitle: '看构建',
          sessionState: 'running',
        },
      ],
    });
    await render(<SecretaryPanel />);
    await flush();
    const row = container.querySelector('[data-enso="secretary-todo"]');
    expect(row?.getAttribute('data-phase')).toBe('active');
    expect(row?.textContent).toContain('看构建');
    expect(row?.textContent).toContain('[Running]');
    click('[data-enso="secretary-todo-session"]');
    expect(useSessionPeek.getState().conversationId).toBe('c9');
    expect(h.calls.some((call) => call.name === 'selectConversation')).toBe(false);
    click('[data-enso="secretary-todo-reopen"]');
    expect(h.calls).toContainEqual({
      name: 'mutateTodo',
      args: { action: 'reopen', todoId: 't1' },
    });
  });

  it('进行中数字点开列出会话，条数与数字一致', async () => {
    h.board = h.secretary.board = board({
      running: [
        sessionCard('c1', { title: '跑全量测试' }),
        sessionCard('c2', {
          title: '等构建',
          state: 'idle',
          continuing: true,
          backgroundRunning: true,
        }),
        sessionCard('c3', { title: '接管的活', state: 'idle', continuing: true, takeover: true }),
      ],
    });
    await render(<SecretaryPanel />);
    await flush();
    expect(text('[data-enso="secretary-summary"]')).toContain('3 running');
    expect(container.querySelector('[data-enso="secretary-running"]')).toBeNull();

    click('[data-enso="secretary-running-toggle"]');
    const rows = [
      ...container.querySelectorAll(
        '[data-enso="secretary-running"] [data-enso="secretary-running-row"]'
      ),
    ];
    expect(rows).toHaveLength(3);
    expect(text('[data-enso="secretary-running"]')).toContain('[In progress]3');
    expect(rows[0].textContent).toContain('[Running]');
    expect(rows[0].textContent).toContain('跑全量测试');
    expect(rows[0].textContent).toContain('enso-code');
    expect(rows[1].textContent).toContain('[Waiting on a background task]');
    expect(rows[2].textContent).toContain('[Continuing]');
    expect(rows[2].querySelector('[data-enso="secretary-running-takeover"]')?.textContent).toBe(
      '[Taken over]'
    );
    expect(rows[0].querySelector('[data-enso="secretary-running-takeover"]')).toBeNull();
    expect(rows[0].getAttribute('data-open')).toBe('false');
  });

  it('停住的会话在进行中列表标出已停住', async () => {
    h.board = h.secretary.board = board({
      running: [
        sessionCard('c1', {
          title: '打包安装',
          state: 'idle',
          continuing: true,
          stalled: { reason: 'goal-idle-stalled', at: NOW - 3 * 60_000 },
        }),
      ],
    });
    await render(<SecretaryPanel />);
    await flush();
    click('[data-enso="secretary-running-toggle"]');
    const rows = [
      ...container.querySelectorAll(
        '[data-enso="secretary-running"] [data-enso="secretary-running-row"]'
      ),
    ];
    expect(rows).toHaveLength(1);
    expect(rows[0].querySelector('[data-enso="secretary-running-badge"]')?.textContent).toBe(
      '[Stalled, no activity]'
    );
    expect(rows[0].textContent).toContain('打包安装');
  });

  it('正在等子代理的会话在进行中列表显示等子代理徽标与子代理名称和耗时', async () => {
    h.board = h.secretary.board = board({
      running: [
        sessionCard('c1', {
          title: '门禁修复',
          state: 'running',
          subagents: [
            {
              agentId: 'a1',
              runId: 'r1',
              title: '实现子代理',
              elapsedMs: 5 * 60_000,
              activity: 'bash pnpm test',
            },
          ],
        }),
      ],
    });
    await render(<SecretaryPanel />);
    await flush();
    click('[data-enso="secretary-running-toggle"]');
    const rows = [
      ...container.querySelectorAll(
        '[data-enso="secretary-running"] [data-enso="secretary-running-row"]'
      ),
    ];
    expect(rows).toHaveLength(1);
    expect(rows[0].querySelector('[data-enso="secretary-running-badge"]')?.textContent).toBe(
      '[Waiting on subagent]'
    );
    const subagentText =
      rows[0].querySelector('[data-enso="secretary-running-subagents"]')?.textContent ?? '';
    expect(subagentText).toContain('实现子代理');
    expect(subagentText).toContain('5m');
    expect(subagentText).toContain('bash pnpm test');
  });

  it('已完成或出错的会话不进进行中列表', async () => {
    h.board = h.secretary.board = board({
      running: [sessionCard('c1', { title: '在跑的活' })],
      done: [
        sessionCard('c2', {
          title: '做完的活',
          state: 'idle',
          result: 'goal-complete',
          resultAt: NOW - 1000,
        }),
        sessionCard('c3', {
          title: '挂掉的活',
          state: 'error',
          result: 'failed',
          resultAt: NOW - 1000,
        }),
      ],
    });
    await render(<SecretaryPanel />);
    await flush();
    click('[data-enso="secretary-running-toggle"]');
    const rows = [
      ...container.querySelectorAll(
        '[data-enso="secretary-running"] [data-enso="secretary-running-row"]'
      ),
    ];
    expect(rows).toHaveLength(1);
    const list = container.querySelector('[data-enso="secretary-running"]')?.textContent ?? '';
    expect(list).toContain('在跑的活');
    expect(list).not.toContain('做完的活');
    expect(list).not.toContain('挂掉的活');
  });

  it('进行中行点主体只展开，右侧图标弹窗看会话，关掉后展开状态不变', async () => {
    h.board = h.secretary.board = board({
      running: [sessionCard('c1', { title: '跑全量测试', lastText: '第 3 步' })],
    });
    await render(<SecretaryPanel />);
    await flush();
    click('[data-enso="secretary-running-toggle"]');
    const expand = () =>
      container.querySelector(
        '[data-enso="secretary-running"] [data-enso="secretary-running-expand"]'
      );
    const row = () =>
      container.querySelector(
        '[data-enso="secretary-running"] [data-enso="secretary-running-row"]'
      );
    expect(expand()?.getAttribute('aria-expanded')).toBe('false');
    expect(row()?.textContent).not.toContain('Started ');

    click('[data-enso="secretary-running-expand"]');
    expect(expand()?.getAttribute('aria-expanded')).toBe('true');
    expect(row()?.getAttribute('data-open')).toBe('true');
    expect(row()?.textContent).toContain('Started ');
    expect(h.calls).not.toContainEqual({ name: 'selectConversation', args: 'c1' });

    click('[data-enso="secretary-running-open"]');
    expect(useSessionPeek.getState().conversationId).toBe('c1');
    expect(h.calls).not.toContainEqual({ name: 'selectConversation', args: 'c1' });
    expect(expand()?.getAttribute('aria-expanded')).toBe('true');

    act(() => useSessionPeek.getState().close());
    expect(useSessionPeek.getState().conversationId).toBeNull();
    expect(container.querySelector('[data-enso="secretary-running"]')).not.toBeNull();
    expect(expand()?.getAttribute('aria-expanded')).toBe('true');
  });

  it('进行中行显示派发时实际用到的模型', async () => {
    h.board = h.secretary.board = board({
      running: [sessionCard('c1', { model: { providerId: 'anthropic', modelId: 'opus' } })],
    });
    await render(<SecretaryPanel />);
    await flush();
    click('[data-enso="secretary-running-toggle"]');
    const model = container.querySelector(
      '[data-enso="secretary-running"] [data-enso="secretary-running-model"]'
    );
    expect(model?.textContent).toContain('opus');
  });

  it('进行中行悬停可以就地标记完成，不占位置也不打开会话', async () => {
    h.board = h.secretary.board = board({
      running: [sessionCard('c1', { title: '跑全量测试' })],
    });
    await render(<SecretaryPanel />);
    await flush();
    click('[data-enso="secretary-running-toggle"]');
    const row = container.querySelector(
      '[data-enso="secretary-running"] [data-enso="secretary-running-row"]'
    );
    expect(row?.querySelector('[data-slot="hover-actions"]')).not.toBeNull();

    click('[data-enso="secretary-running-mark-done"]');
    expect(h.calls).toContainEqual({ name: 'markResult', args: ['c1', 'done'] });
    expect(h.calls).not.toContainEqual({ name: 'selectConversation', args: 'c1' });
  });

  it('没有进行中的会话时给一行空状态', async () => {
    await render(createElement(SecretaryRunningList));
    await flush();
    expect(text('[data-enso="secretary-running"]')).toBe('[In progress]0[Nothing running]');
    expect(
      container.querySelector('[data-enso="secretary-running"] [data-enso="secretary-running-row"]')
    ).toBeNull();
  });

  it('Main 推送新状态后展开的列表跟着变', async () => {
    h.board = h.secretary.board = board({ running: [sessionCard('c1', { title: '第一件' })] });
    await render(<SecretaryPanel />);
    await flush();
    click('[data-enso="secretary-running-toggle"]');
    expect(
      container.querySelectorAll(
        '[data-enso="secretary-running"] [data-enso="secretary-running-row"]'
      )
    ).toHaveLength(1);

    h.board = h.secretary.board = board({
      running: [sessionCard('c1', { title: '第一件' }), sessionCard('c2', { title: '第二件' })],
    });
    await render(<SecretaryPanel />);
    await flush();
    const rows = [
      ...container.querySelectorAll(
        '[data-enso="secretary-running"] [data-enso="secretary-running-row"]'
      ),
    ];
    expect(rows).toHaveLength(2);
    expect(text('[data-enso="secretary-running"]')).toContain('[In progress]2');
    expect(text('[data-enso="secretary-summary"]')).toContain('2 running');
  });

  it('联系方式标签直接管理：分组卡片里有主人身份与渠道，不再是占位跳转', async () => {
    await render(<SecretaryPanel />);
    await flush();
    click('[data-enso="secretary-panel-tab"][data-tab="contact"]');
    await flush();
    expect(container.querySelector('[data-enso="secretary-contact"]')).not.toBeNull();
    expect(container.querySelector('[data-enso="secretary-contact-owner"]')).not.toBeNull();
    expect(container.querySelector('[data-settings-row="contacts.owner"]')).not.toBeNull();
    expect(container.querySelector('[data-settings-row="contacts.channels"]')).not.toBeNull();
    expect(container.querySelector('[data-enso="secretary-contact-entry"]')).toBeNull();
    expect(container.textContent).not.toContain('managed in Settings');
  });

  it('标签切到记忆与定时，定时分系统与秘书定的两组', async () => {
    await render(<SecretaryPanel />);
    await flush();
    click('[data-enso="secretary-panel-tab"][data-tab="memory"]');
    expect(container.querySelector('[data-enso="secretary-memory"]')).not.toBeNull();
    expect(container.querySelector('[data-enso="secretary-workbench"]')).toBeNull();
    click('[data-enso="secretary-panel-tab"][data-tab="schedules"]');
    await flush();
    const schedules = container.querySelector('[data-enso="secretary-schedules"]');
    expect(schedules?.textContent).toContain('[System]');
    expect(schedules?.textContent).toContain('每日晨报');
    expect(schedules?.textContent).toContain('每周五汇总');
    expect(schedules?.textContent).toContain('To add a schedule, just tell 小安');
    const rows = [...container.querySelectorAll('[data-enso="secretary-schedule"]')];
    expect(rows.map((row) => row.getAttribute('data-system'))).toEqual(['true', null]);
  });

  it('Main 推送后定时标签自动重读，新增与运行时间都不用手动刷新', async () => {
    h.schedules = [];
    await render(<SecretaryPanel />);
    await flush();
    click('[data-enso="secretary-panel-tab"][data-tab="schedules"]');
    expect(container.querySelectorAll('[data-enso="secretary-schedule"]')).toHaveLength(0);

    h.schedules = [
      { id: 's3', name: '巡检', prompt: '看看', cron: '*/10 * * * *', nextRunAt: NOW + 600_000 },
    ];
    act(() => {
      for (const listener of h.stateListeners) listener();
    });
    await flush();
    expect(text('[data-enso="secretary-schedules"]')).toContain('巡检');

    h.schedules = [
      {
        id: 's3',
        name: '巡检',
        prompt: '看看',
        cron: '*/10 * * * *',
        lastFiredAt: NOW,
        nextRunAt: NOW + 600_000,
      },
    ];
    act(() => {
      for (const listener of h.stateListeners) listener();
    });
    await flush();
    expect(text('[data-enso="secretary-schedule"]')).toContain('Last run');
  });
});
