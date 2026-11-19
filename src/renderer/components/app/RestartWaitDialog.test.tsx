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
let push: ((waiting: boolean, reason?: string) => void) | undefined;
const forceRestart = vi.fn();
const dialog = () => container.querySelector('[role="alertdialog"]');

beforeEach(async () => {
  const { window } = parseHTML('<html><body><div id="root"></div></body></html>');
  vi.stubGlobal('window', window);
  vi.stubGlobal('document', window.document);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  forceRestart.mockReset();
  push = undefined;
  Object.assign(window, {
    electronAPI: {
      app: {
        onRestartWaiting: (callback: (waiting: boolean, reason?: string) => void) => {
          push = callback;
          return () => {
            push = undefined;
          };
        },
        forceRestart,
      },
    },
  });
  container = window.document.getElementById('root') as unknown as HTMLElement;
  root = createRoot(container);
  await act(async () => root.render(createElement(RestartWaitDialog)));
});

afterEach(async () => {
  await act(async () => root.unmount());
  vi.unstubAllGlobals();
});

describe('RestartWaitDialog', () => {
  it('等命令时出现（带 loading），命令结束后关掉', async () => {
    expect(dialog()).toBeNull();
    await act(async () => push?.(true));
    expect(dialog()?.textContent).toContain('Waiting for the current command to finish');
    expect(dialog()?.querySelector('[role="status"]')).not.toBeNull();
    await act(async () => push?.(false));
    expect(dialog()).toBeNull();
    expect(forceRestart).not.toHaveBeenCalled();
  });

  it('强制退出：立刻通知 Main，不等命令；按钮防重复点', async () => {
    await act(async () => push?.(true));
    const button = dialog()?.querySelector('button');
    expect(button?.textContent).toBe('Force quit');
    await act(async () => button?.click());
    expect(forceRestart).toHaveBeenCalledTimes(1);
    expect(dialog()?.querySelector('button')?.hasAttribute('disabled')).toBe(true);
  });

  it('在等的是脱离不了的转后台命令：多一句说明；普通命令不说', async () => {
    const note = 'cannot keep running without EnsoCode';
    await act(async () => push?.(true, 'tool'));
    expect(dialog()?.textContent).not.toContain(note);
    await act(async () => push?.(true, 'background-not-detachable'));
    expect(dialog()?.textContent).toContain(note);
    expect(dialog()?.textContent).toContain(
      'EnsoCode will restart once the current command finishes.'
    );
  });
});
