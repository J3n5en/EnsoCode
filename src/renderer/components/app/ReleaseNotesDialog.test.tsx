import type { UpdateStatus } from '@shared/types/updater';
import { parseHTML } from 'linkedom';
import { act, type ComponentProps, createElement, type ReactNode, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ReleaseNotesDialog } from './ReleaseNotesDialog';
import { UpdateBanner } from './UpdateBanner';

vi.mock('@/i18n', () => ({
  useI18n: () => ({
    t: (key: string, vars?: Record<string, string>) =>
      key.replace(/\{\{(\w+)\}\}/g, (_, name: string) => vars?.[name] ?? ''),
  }),
}));
vi.mock('@/components/chat/Markdown', () => ({ markdownComponents: {} }));
const addToast = vi.hoisted(() => vi.fn());
vi.mock('@/components/ui/toast', () => ({ addToast }));
vi.mock('@/components/ui/button', () => ({
  Button: ({
    children,
    size: _size,
    variant: _variant,
    ...props
  }: ComponentProps<'button'> & { size?: string; variant?: string }) =>
    createElement('button', { type: 'button', ...props }, children),
}));
vi.mock('@/components/ui/dialog', async () => {
  const { createContext, createElement: h, useContext } = await import('react');
  const Close = createContext<() => void>(() => {});
  const Wrap = ({ children }: { children?: ReactNode }) => h('div', null, children);
  return {
    Dialog: ({
      open,
      onOpenChange,
      children,
    }: {
      open: boolean;
      onOpenChange: (open: boolean) => void;
      children?: ReactNode;
    }) =>
      open
        ? h(
            Close.Provider,
            { value: () => onOpenChange(false) },
            h('div', { role: 'dialog' }, children)
          )
        : null,
    DialogClose: ({ children }: { children?: ReactNode }) =>
      h('button', { type: 'button', onClick: useContext(Close) }, children),
    DialogDescription: Wrap,
    DialogFooter: Wrap,
    DialogHeader: Wrap,
    DialogPanel: Wrap,
    DialogPopup: Wrap,
    DialogTitle: Wrap,
  };
});

let root: Root;
let container: HTMLElement;
const downloadUpdate = vi.fn();
const quitAndInstall = vi.fn();
const dialog = () => container.querySelector('[role="dialog"]');
const buttonOf = (text: string) =>
  [...(dialog()?.querySelectorAll('button') ?? [])].find((b) => b.textContent === text) as
    | HTMLButtonElement
    | undefined;

let push: (status: UpdateStatus) => void = () => {};

/** 与 Main 一致：downloading / error 状态不带 info */
const downloading = (percent: number): UpdateStatus => ({
  status: 'downloading',
  progress: { percent, bytesPerSecond: 0, total: 0, transferred: 0 },
});

function Host({ initial }: { initial: UpdateStatus }) {
  const [open, setOpen] = useState(true);
  const [status, setStatus] = useState(initial);
  push = setStatus;
  downloadUpdate.mockImplementation(async () => setStatus(downloading(0)));
  return createElement(ReleaseNotesDialog, { open, onOpenChange: setOpen, status });
}

async function render(element: ReturnType<typeof createElement>): Promise<void> {
  const { window } = parseHTML('<html><body><div id="root"></div></body></html>');
  vi.stubGlobal('window', window);
  vi.stubGlobal('document', window.document);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  Object.assign(window, {
    electronAPI: {
      updater: {
        downloadUpdate,
        quitAndInstall,
        getState: async () => ({ host: 'desktop', status: null }),
        onStatus: (listener: (status: UpdateStatus) => void) => {
          push = listener;
          return () => {};
        },
      },
    },
  });
  container = window.document.getElementById('root') as unknown as HTMLElement;
  root = createRoot(container);
  await act(async () => root.render(element));
}

const mount = (status: UpdateStatus) => render(createElement(Host, { initial: status }));

const available = {
  status: 'available',
  info: { version: '9.9.9', releaseNotes: 'Release notes body' },
} as UpdateStatus;

afterEach(async () => {
  await act(async () => root?.unmount());
  vi.unstubAllGlobals();
  downloadUpdate.mockReset();
  quitAndInstall.mockReset();
  addToast.mockReset();
});

describe('ReleaseNotesDialog', () => {
  it('点「下载更新」开始下载，对话框保持打开、日志仍可读，下载按钮消失', async () => {
    await mount(available);
    await act(async () => buttonOf('Download update')?.click());
    expect(downloadUpdate).toHaveBeenCalledTimes(1);
    expect(dialog()).not.toBeNull();
    expect(dialog()?.textContent).toContain('Release notes body');
    expect(buttonOf('Download update')).toBeUndefined();
  });

  it('关闭按钮仍能关掉对话框', async () => {
    await mount(available);
    await act(async () => buttonOf('Download update')?.click());
    expect(dialog()).not.toBeNull();
    await act(async () => buttonOf('Later')?.click());
    expect(dialog()).toBeNull();
  });

  it('下载中与下载失败的状态不带 info 时仍显示原日志，并在对话框里给出进度与错误', async () => {
    await mount(available);
    await act(async () => buttonOf('Download update')?.click());
    await act(async () => push(downloading(42.4)));
    expect(dialog()?.textContent).toContain("What's new in 9.9.9");
    expect(dialog()?.textContent).toContain('Release notes body');
    expect(dialog()?.textContent).toContain('Downloading update… 42%');
    await act(async () => push({ status: 'error', error: 'net::ERR_INTERNET_DISCONNECTED' }));
    expect(dialog()?.textContent).toContain('Release notes body');
    expect(dialog()?.textContent).toContain('Update failed: net::ERR_INTERNET_DISCONNECTED');
  });

  it('下载完成后点「重启以更新」先关掉对话框再重启，不和重启等待蒙版叠在一起', async () => {
    await mount(available);
    await act(async () => push({ ...available, status: 'downloaded' } as UpdateStatus));
    await act(async () => buttonOf('Restart to update')?.click());
    expect(quitAndInstall).toHaveBeenCalledTimes(1);
    expect(dialog()).toBeNull();
  });

  it('重启没被受理时给出提示，不再静默', async () => {
    quitAndInstall.mockResolvedValue({ ok: false, reason: 'error', error: 'boom' });
    await mount({ ...available, status: 'downloaded' } as UpdateStatus);
    await act(async () => buttonOf('Restart to update')?.click());
    expect(addToast).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'error',
        title:
          'Restart to update failed: boom. Try Restart to update again in a moment; if it still fails, quit EnsoCode completely and reopen it.',
      })
    );
  });
});

describe('UpdateBanner', () => {
  it('下载失败时更新日志对话框不随横幅消失，关掉后也不会在下次发现新版时自己弹出', async () => {
    await render(createElement(UpdateBanner));
    await act(async () => push(available));
    const notes = [...container.querySelectorAll('button')].find(
      (b) => b.textContent === 'Release notes'
    );
    await act(async () => notes?.click());
    await act(async () => buttonOf('Download update')?.click());
    await act(async () => push(downloading(10)));
    await act(async () => push({ status: 'error', error: 'boom' }));
    expect(dialog()?.textContent).toContain('Release notes body');
    expect(dialog()?.textContent).toContain('Update failed: boom');
    await act(async () => buttonOf('Later')?.click());
    expect(dialog()).toBeNull();
    await act(async () => push(available));
    expect(dialog()).toBeNull();
  });
});
