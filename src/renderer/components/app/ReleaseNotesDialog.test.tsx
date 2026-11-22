import type { UpdateStatus } from '@shared/types/updater';
import { parseHTML } from 'linkedom';
import { act, type ComponentProps, createElement, type ReactNode, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ReleaseNotesDialog } from './ReleaseNotesDialog';

vi.mock('@/i18n', () => ({
  useI18n: () => ({
    t: (key: string, vars?: Record<string, string>) =>
      key.replace(/\{\{(\w+)\}\}/g, (_, name: string) => vars?.[name] ?? ''),
  }),
}));
vi.mock('@/components/chat/Markdown', () => ({ markdownComponents: {} }));
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
const dialog = () => container.querySelector('[role="dialog"]');
const buttonOf = (text: string) =>
  [...(dialog()?.querySelectorAll('button') ?? [])].find((b) => b.textContent === text) as
    | HTMLButtonElement
    | undefined;

function Host({ initial }: { initial: UpdateStatus }) {
  const [open, setOpen] = useState(true);
  const [status, setStatus] = useState(initial);
  downloadUpdate.mockImplementation(async () =>
    setStatus((s) => ({ ...s, status: 'downloading' }))
  );
  return createElement(ReleaseNotesDialog, { open, onOpenChange: setOpen, status });
}

async function mount(status: UpdateStatus): Promise<void> {
  const { window } = parseHTML('<html><body><div id="root"></div></body></html>');
  vi.stubGlobal('window', window);
  vi.stubGlobal('document', window.document);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  Object.assign(window, { electronAPI: { updater: { downloadUpdate } } });
  container = window.document.getElementById('root') as unknown as HTMLElement;
  root = createRoot(container);
  await act(async () => root.render(createElement(Host, { initial: status })));
}

const available = {
  status: 'available',
  info: { version: '9.9.9', releaseNotes: 'Release notes body' },
} as UpdateStatus;

afterEach(async () => {
  await act(async () => root?.unmount());
  vi.unstubAllGlobals();
  downloadUpdate.mockReset();
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
});
