import { parseHTML } from 'linkedom';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TimelineItem } from '@/stores/sessions/timeline';
import { TimelineRow } from './TimelineRow';

const store = vi.hoisted(() => ({
  state: {
    activeId: 'c1',
    conversations: {
      c1: {
        id: 'c1',
        messages: [],
        status: 'idle',
        backgroundTasks: [
          {
            taskId: 'task-2-b',
            command: `ssh green 'cd /opt/psbot && sleep 90 && docker compose logs bot --tail 12'`,
            status: 'running',
            tail: '',
            startedAt: 0,
          },
        ],
      },
    },
    selectConversation: () => undefined,
  } as Record<string, unknown>,
  setState: vi.fn(),
}));

vi.mock('@/i18n', () => ({
  useI18n: () => ({
    t: (key: string, vars?: Record<string, unknown>) =>
      vars ? key.replace(/\{\{(\w+)\}\}/g, (_, name: string) => String(vars[name] ?? '')) : key,
    locale: 'en',
  }),
}));
vi.mock('@/stores/settings', () => {
  const state = { autoCollapseTurns: false, projects: [], compactReadOnlyTools: false };
  const useSettingsStore = (select: (value: object) => unknown) => select(state);
  useSettingsStore.getState = () => state;
  return { useSettingsStore };
});
vi.mock('@/stores/sessions', () => {
  const useSessionsStore = (select: (value: object) => unknown) => select(store.state);
  useSessionsStore.getState = () => store.state;
  useSessionsStore.setState = store.setState;
  return { useSessionsStore };
});
vi.mock('@/stores/secretary', () => {
  const state = { secretary: { board: { todos: [] }, proposals: {} }, resolving: {} };
  const useSecretaryStore = (select: (value: object) => unknown) => select(state);
  useSecretaryStore.getState = () => state;
  return { useSecretaryStore };
});
vi.mock('./Markdown', () => ({ Markdown: ({ text }: { text: string }) => text }));

const INSTRUCTION = 'Call task_settle once for all of them';
const W = [
  '<background-tasks-wrap-up>',
  'These background tasks are still running and you have not said what happens to them:',
  '- task-1-a: pnpm dev (running 0m)',
  `- task-2-b: ssh green 'cd /opt/psbot && sleep 90 && docker (running 3m)`,
  '- task-3-c: vite preview --port 4173 (running 1h 2m)',
  `${INSTRUCTION}: stop each one you no longer need, or keep it with a one-line reason the user will see. Do not leave them undeclared.`,
  '</background-tasks-wrap-up>',
].join('\n');

let root: Root | undefined;

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = undefined;
  store.setState.mockClear();
  vi.unstubAllGlobals();
});

async function mount(text: string, hostTaskWrapUp?: boolean) {
  const dom = parseHTML('<html><body><div id="root"></div></body></html>');
  vi.stubGlobal('window', dom.window);
  vi.stubGlobal('document', dom.document);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const container = dom.document.getElementById('root');
  if (!container) throw new Error('Missing test root');
  root = createRoot(container);
  const item = {
    kind: 'user',
    key: '0',
    text,
    images: [],
    ...(hostTaskWrapUp ? { hostTaskWrapUp } : {}),
  } as TimelineItem;
  await act(async () => {
    root?.render(createElement(TimelineRow, { item }));
  });
  const card = () => container.querySelector('[data-enso="task-wrap-up"]') as HTMLElement | null;
  const click = async (element: Element | null | undefined) => {
    await act(async () => {
      (element as HTMLElement).click();
    });
  };
  return { container, card, click };
}

describe('后台任务收尾清单', () => {
  it('宿主注入的清单收成一行系统卡片，不露标签和英文指令，用户正文照常是气泡', async () => {
    const ui = await mount(`${W}\n\n继续干活`, true);
    const card = ui.card();
    expect(card?.getAttribute('data-open')).toBe('false');
    expect(card?.textContent).toContain('3 background tasks to wrap up');
    const text = ui.container.textContent ?? '';
    expect(text).not.toContain('background-tasks-wrap-up');
    expect(text).not.toContain(INSTRUCTION);
    expect(text).not.toContain('task-1-a');
    expect(text).toContain('继续干活');
  });

  it('展开后逐条列出任务 id、单行命令与已运行时长，长命令悬停可看全文', async () => {
    const ui = await mount(W, true);
    await ui.click(ui.card()?.querySelector('button'));
    const rows = [...ui.container.querySelectorAll('[data-enso="task-wrap-up-item"]')];
    expect(rows.map((row) => row.getAttribute('data-task-id'))).toEqual([
      'task-1-a',
      'task-2-b',
      'task-3-c',
    ]);
    expect(rows[0]?.textContent).toContain('pnpm dev');
    expect(rows[2]?.textContent).toContain('Running for 1h 2m');
    const command = rows[1]?.querySelector('[data-enso="task-wrap-up-command"]');
    expect(command?.className).toContain('truncate');
    expect(command?.getAttribute('title')).toContain('docker compose logs bot --tail 12');
    expect(ui.container.textContent).not.toContain(INSTRUCTION);
  });

  it('任务还在跑时可跳到任务条，交给 TaskBar 打开它', async () => {
    const ui = await mount(W, true);
    await ui.click(ui.card()?.querySelector('button'));
    const opens = ui.container.querySelectorAll('[data-enso="task-wrap-up-open"]');
    expect(opens).toHaveLength(1);
    await ui.click(opens[0]);
    expect(store.setState).toHaveBeenCalledWith({
      pendingAgentOpen: { sessionId: 'c1', agentId: 'task-2-b' },
    });
  });

  it('用户自己发的同样文字仍是用户气泡，原样显示', async () => {
    const ui = await mount(W);
    expect(ui.card()).toBeNull();
    expect(ui.container.textContent).toContain('<background-tasks-wrap-up>');
    expect(ui.container.textContent).toContain(INSTRUCTION);
  });
});

describe('工作区切换分支提示', () => {
  it('渲染成系统事件行，不露原始标签', async () => {
    const ui = await mount(
      '<workspace-branch-changed>\nThe current workspace is now on Git branch "feat/x". The directory is unchanged.\n</workspace-branch-changed>\n\n看看'
    );
    const text = ui.container.textContent ?? '';
    expect(text).not.toContain('<workspace-branch-changed>');
    expect(text).toContain('Workspace switched to branch feat/x');
    expect(text).toContain('看看');
  });
});
