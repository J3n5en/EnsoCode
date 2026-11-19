import type { RestartOverlayState } from '@shared/types/ipc';
import { parseHTML } from 'linkedom';
import { act, type ComponentProps, createElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RestartWaitDialog } from './RestartWaitDialog';

vi.mock('@/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
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

async function mount(): Promise<void> {
  const { window } = parseHTML('<html><body><div id="root"></div></body></html>');
  vi.stubGlobal('window', window);
  vi.stubGlobal('document', window.document);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  Object.assign(window, {
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
  await act(async () => root.render(createElement(RestartWaitDialog)));
}

beforeEach(() => {
  forceRestart.mockReset();
  push = undefined;
  initial = null;
  remote = undefined;
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
    const button = dialog()?.querySelector('button');
    expect(button?.textContent).toBe('Force quit');
    await act(async () => button?.click());
    expect(forceRestart).toHaveBeenCalledTimes(1);
    expect(dialog()?.querySelector('button')?.hasAttribute('disabled')).toBe(true);
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
      await act(async () => dialog()?.querySelector('button')?.click());
      expect(forceRestart).toHaveBeenCalledTimes(1);
      await act(async () => push?.(null));
      expect(dialog()).toBeNull();
    }
  );
});
