import { translate } from '@shared/i18n';
import type { RestartOverlayState } from '@shared/types/ipc';
import { parseHTML } from 'linkedom';
import { act, type ComponentProps, createElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RestartWaitDialog, RestartWaitStrip, useRestartOverlayStore } from './RestartWaitDialog';

const sessions = vi.hoisted(() => ({
  conversations: {} as Record<string, { title: string }>,
}));

const translateKey = (key: string, params?: Record<string, string | number>) =>
  params ? key.replace(/\{\{(\w+)\}\}/g, (_, token: string) => String(params[token] ?? '')) : key;

vi.mock('@/i18n', () => ({ useI18n: () => ({ t: translateKey }) }));
vi.mock('@/stores/sessions', () => ({
  useSessionsStore: (
    selector: (state: { conversations: typeof sessions.conversations }) => unknown
  ) => selector({ conversations: sessions.conversations }),
}));
vi.mock('@/components/ui/alert-dialog', () => {
  const Wrap = ({ children }: { children?: ReactNode }) => createElement('div', null, children);
  return {
    AlertDialog: ({ open, children }: { open: boolean; children?: ReactNode }) =>
      open ? createElement('div', { role: 'alertdialog' }, children) : null,
    AlertDialogDescription: Wrap,
    AlertDialogFooter: Wrap,
    AlertDialogHeader: Wrap,
    AlertDialogPopup: Wrap,
    AlertDialogTitle: Wrap,
  };
});
vi.mock('@/components/ui/button', () => ({
  Button: ({
    children,
    size: _size,
    variant: _variant,
    ...props
  }: ComponentProps<'button'> & { size?: string; variant?: string }) =>
    createElement('button', { type: 'button', ...props }, children),
}));
vi.mock('@/components/ui/spinner', () => ({
  Spinner: () => createElement('span', { role: 'status' }),
}));

let root: Root;
let container: HTMLElement;
let push: ((state: RestartOverlayState | null) => void) | undefined;
let initial: RestartOverlayState | null = null;
let remote: object | undefined;
const forceRestart = vi.fn();
const dialog = () => container.querySelector('[role="alertdialog"]');
const strip = () => container.querySelector('#strip')?.firstElementChild ?? null;
const buttonOf = (el: Element | null | undefined, text: string) =>
  [...(el?.querySelectorAll('button') ?? [])].find((b) => b.textContent === text) as
    | HTMLButtonElement
    | undefined;

async function mount(): Promise<void> {
  const { window } = parseHTML('<html><body><div id="root"></div></body></html>');
  vi.stubGlobal('window', window);
  vi.stubGlobal('document', window.document);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  Object.assign(window, {
    // 高度展开动画在 linkedom 里跑不完：全程按 prefers-reduced-motion 走瞬时路径，
    // 出现/消失断言仍校验行为开关，不依赖插值时长
    matchMedia: (query: string) => ({
      matches: query.includes('prefers-reduced-motion'),
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      onchange: null,
      dispatchEvent: () => false,
    }),
    electronAPI: {
      remote,
      app: {
        onRestartWaiting: (callback: (state: RestartOverlayState | null) => void) => {
          push = callback;
          return () => {
            push = undefined;
          };
        },
        getRestartWaiting: async () => initial,
        forceRestart,
      },
    },
  });
  container = window.document.getElementById('root') as unknown as HTMLElement;
  root = createRoot(container);
  await act(async () =>
    root.render(
      createElement(
        'div',
        null,
        createElement('div', { id: 'strip' }, createElement(RestartWaitStrip)),
        createElement(RestartWaitDialog)
      )
    )
  );
}

beforeEach(() => {
  forceRestart.mockReset();
  push = undefined;
  initial = null;
  remote = undefined;
  sessions.conversations = {};
  useRestartOverlayStore.setState({
    state: null,
    shown: { phase: 'restarting' },
    forcing: false,
    minimized: false,
  });
});

afterEach(async () => {
  await act(async () => root?.unmount());
  vi.unstubAllGlobals();
});

describe('RestartWaitDialog', () => {
  it('等命令时出现（带 loading），命令结束后关掉', async () => {
    await mount();
    expect(dialog()).toBeNull();
    await act(async () => push?.({ phase: 'waiting', reason: 'tool', exit: 'restart' }));
    expect(dialog()?.textContent).toContain('Waiting for the current command to finish');
    expect(dialog()?.querySelector('[role="status"]')).not.toBeNull();
    await act(async () => push?.(null));
    expect(dialog()).toBeNull();
    expect(forceRestart).not.toHaveBeenCalled();
  });

  it('强制退出：立刻通知 Main，不等命令；按钮防重复点', async () => {
    await mount();
    await act(async () => push?.({ phase: 'waiting', reason: 'tool', exit: 'restart' }));
    const button = buttonOf(dialog(), 'Force quit');
    expect(button).toBeDefined();
    await act(async () => button?.click());
    expect(forceRestart).toHaveBeenCalledTimes(1);
    expect(buttonOf(dialog(), 'Force quit')?.hasAttribute('disabled')).toBe(true);
  });

  it('在等的是脱离不了的转后台命令：多一句说明；普通命令不说', async () => {
    await mount();
    const note = 'cannot keep running without EnsoCode';
    await act(async () => push?.({ phase: 'waiting', reason: 'tool', exit: 'restart' }));
    expect(dialog()?.textContent).not.toContain(note);
    await act(async () =>
      push?.({ phase: 'waiting', reason: 'background-not-detachable', exit: 'restart' })
    );
    expect(dialog()?.textContent).toContain(note);
    expect(dialog()?.textContent).toContain(
      'EnsoCode will restart once the current command finishes.'
    );
  });

  it('没有命令在跑：点重启直接是「正在重启」（带 loading，无强制退出）', async () => {
    await mount();
    await act(async () => push?.({ phase: 'restarting' }));
    expect(dialog()?.textContent).toContain('Restarting EnsoCode…');
    expect(dialog()?.textContent).not.toContain('Waiting for the current command to finish');
    expect(dialog()?.querySelector('[role="status"]')).not.toBeNull();
    expect(dialog()?.querySelector('button')).toBeNull();
  });

  it('有命令在跑：先等命令，等到了同一个弹层切成「正在重启」', async () => {
    await mount();
    await act(async () => push?.({ phase: 'waiting', reason: 'tool', exit: 'restart' }));
    expect(dialog()?.textContent).toContain('Waiting for the current command to finish');
    await act(async () => push?.({ phase: 'restarting' }));
    expect(dialog()?.textContent).toContain('Restarting EnsoCode…');
    expect(dialog()?.textContent).not.toContain('Waiting for the current command to finish');
    expect(dialog()?.querySelector('button')).toBeNull();
  });

  it('新实例：挂载时取到恢复中就显示「正在恢复会话」，恢复完成后消失', async () => {
    initial = { phase: 'resuming' };
    await mount();
    expect(dialog()?.textContent).toContain('Restoring sessions…');
    expect(dialog()?.querySelector('[role="status"]')).not.toBeNull();
    expect(dialog()?.querySelector('button')).toBeNull();
    await act(async () => push?.(null));
    expect(dialog()).toBeNull();
  });

  it('没有要恢复的会话：启动不显示', async () => {
    await mount();
    expect(dialog()).toBeNull();
  });

  it('节点页面 / 远程浏览器：不订阅也不显示', async () => {
    remote = {};
    initial = { phase: 'resuming' };
    await mount();
    expect(push).toBeUndefined();
    expect(dialog()).toBeNull();
    expect(strip()).toBeNull();
  });

  it.each([
    ['restart', 'EnsoCode will restart once the current command finishes.'],
    ['update', 'EnsoCode will install the update once the current command finishes.'],
    ['quit', 'EnsoCode will quit once the current command finishes.'],
  ] as const)(
    '同一个弹层按等完要做什么（%s）换说明，都带 loading 和「强制退出」',
    async (exit, text) => {
      await mount();
      await act(async () => push?.({ phase: 'waiting', reason: 'tool', exit }));
      const content = dialog()?.textContent ?? '';
      expect(content).toContain('Waiting for the current command to finish');
      expect(content).toContain(text);
      for (const other of [
        'EnsoCode will restart once',
        'EnsoCode will install the update once',
        'EnsoCode will quit once',
      ].filter((line) => !text.startsWith(line)))
        expect(content).not.toContain(other);
      expect(dialog()?.querySelector('[role="status"]')).not.toBeNull();
      await act(async () => buttonOf(dialog(), 'Force quit')?.click());
      expect(forceRestart).toHaveBeenCalledTimes(1);
      await act(async () => push?.(null));
      expect(dialog()).toBeNull();
    }
  );

  it('最小化：弹层收成小条（loading + 状态 + 强制退出），点小条恢复，不通知 Main', async () => {
    await mount();
    await act(async () => push?.({ phase: 'waiting', reason: 'tool', exit: 'restart' }));
    expect(strip()).toBeNull();
    await act(async () => buttonOf(dialog(), 'Minimize')?.click());
    expect(dialog()).toBeNull();
    expect(strip()?.textContent).toContain('Restarting once the current command finishes');
    expect(strip()?.querySelector('[role="status"]')).not.toBeNull();
    expect(buttonOf(strip(), 'Force quit')).toBeDefined();
    await act(async () =>
      buttonOf(strip(), 'Restarting once the current command finishes')?.click()
    );
    expect(strip()).toBeNull();
    expect(dialog()?.textContent).toContain('Waiting for the current command to finish');
    expect(forceRestart).not.toHaveBeenCalled();
  });

  it('最小化后重新推送等待状态：保持小条，不弹回全屏；文案跟着更新', async () => {
    await mount();
    await act(async () => push?.({ phase: 'waiting', reason: 'tool', exit: 'restart' }));
    await act(async () => buttonOf(dialog(), 'Minimize')?.click());
    await act(async () =>
      push?.({ phase: 'waiting', reason: 'background-not-detachable', exit: 'update' })
    );
    expect(dialog()).toBeNull();
    expect(strip()?.textContent).toContain(
      'Installing the update once the current command finishes'
    );
  });

  it('最小化状态下命令结束：照常切到「正在重启」并恢复全屏；下次等待从全屏开始', async () => {
    await mount();
    await act(async () => push?.({ phase: 'waiting', reason: 'tool', exit: 'restart' }));
    await act(async () => buttonOf(dialog(), 'Minimize')?.click());
    await act(async () => push?.({ phase: 'restarting' }));
    expect(strip()).toBeNull();
    expect(dialog()?.textContent).toContain('Restarting EnsoCode…');
    await act(async () => push?.(null));
    expect(dialog()).toBeNull();
    await act(async () => push?.({ phase: 'waiting', reason: 'tool', exit: 'quit' }));
    expect(strip()).toBeNull();
    expect(dialog()?.textContent).toContain('Waiting for the current command to finish');
  });

  it('小条上直接强制退出：通知 Main 且防重复点', async () => {
    await mount();
    await act(async () => push?.({ phase: 'waiting', reason: 'tool', exit: 'update' }));
    await act(async () => buttonOf(dialog(), 'Minimize')?.click());
    await act(async () => buttonOf(strip(), 'Force quit')?.click());
    expect(forceRestart).toHaveBeenCalledTimes(1);
    expect(buttonOf(strip(), 'Force quit')?.hasAttribute('disabled')).toBe(true);
  });

  it('列出挡住退出的会话：标题和原因，没有标题时用 id 前 8 位，子会话注明子代理', async () => {
    sessions.conversations = {
      'parent-1': { title: '修登录' },
      '779e1533-aaaa-bbbb-cccc-dddddddddddd': { title: '写文档' },
    };
    await mount();
    const blockers = [
      {
        sessionId: '779e1533-aaaa-bbbb-cccc-dddddddddddd',
        kind: 'tool' as const,
        tools: ['bash', 'ask_user'],
      },
      { sessionId: 'parent-1::child-99', kind: 'tool' as const, tools: ['bash'] },
      { sessionId: 'missing1-extra', kind: 'starting' as const },
      { sessionId: 'parent-1', kind: 'reply' as const },
      { sessionId: 'parent-1::bg', kind: 'background' as const },
      { sessionId: 'unknown2', kind: 'turn' as const },
    ];
    await act(async () => push?.({ phase: 'waiting', reason: 'tool', exit: 'quit', blockers }));
    const content = dialog()?.textContent ?? '';
    expect(content).toContain('写文档 — Running bash, ask_user');
    expect(content).toContain('修登录 — A subagent is running bash');
    expect(content).toContain('missing1 — Opening the session');
    expect(content).toContain('修登录 — Writing a reply');
    expect(content).toContain('修登录 — A subagent still has a background command running');
    expect(content).not.toContain('unknown2 — Finishing the turn');
    expect(content).toContain('1 more sessions');
    expect(translate('zh', 'Running {{tool}}', { tool: 'bash' })).toBe('正在执行 bash');
    expect(translate('zh', 'A subagent is running {{tool}}', { tool: 'bash' })).toBe(
      '子代理正在执行 bash'
    );
    expect(translate('zh', 'Opening the session')).toBe('正在打开会话');
    expect(translate('zh', 'Writing a reply')).toBe('正在写回复');
    expect(translate('zh', 'A background command is still running')).toBe('转到后台的命令还在跑');
    expect(translate('zh', '{{count}} more sessions', { count: 1 })).toBe('还有 1 个会话');
  });

  it('最小化小条附上在等的会话数', async () => {
    await mount();
    await act(async () =>
      push?.({
        phase: 'waiting',
        reason: 'tool',
        exit: 'restart',
        blockers: [
          { sessionId: 'aaaaaaaa', kind: 'reply' },
          { sessionId: 'bbbbbbbb', kind: 'starting' },
        ],
      })
    );
    await act(async () => buttonOf(dialog(), 'Minimize')?.click());
    expect(strip()?.textContent).toContain('Restarting once the current command finishes');
    expect(strip()?.textContent).toContain(' · waiting for 2 sessions');
    expect(translate('zh', ' · waiting for {{count}} sessions', { count: 2 })).toBe(
      ' · 等 2 个会话'
    );
  });
});
