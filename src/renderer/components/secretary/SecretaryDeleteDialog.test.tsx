import { getTranslation } from '@shared/i18n';
import { parseHTML } from 'linkedom';
import {
  act,
  type ComponentProps,
  cloneElement,
  createElement,
  type ReactElement,
  type ReactNode,
} from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SecretaryDeleteDialog } from './SecretaryDeleteDialog';

const dialog = vi.hoisted(() => ({ onOpenChange: null as ((open: boolean) => void) | null }));

vi.mock('@/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock('@/components/ui/alert-dialog', () => {
  const Wrap = ({ children }: { children?: ReactNode }) => createElement('div', null, children);
  return {
    AlertDialog: ({
      open,
      onOpenChange,
      children,
    }: {
      open: boolean;
      onOpenChange: (open: boolean) => void;
      children?: ReactNode;
    }) => {
      dialog.onOpenChange = onOpenChange;
      return open ? createElement('div', { role: 'alertdialog' }, children) : null;
    },
    AlertDialogClose: ({ render, children }: { render: ReactElement; children?: ReactNode }) =>
      cloneElement(render, { 'data-enso': 'secretary-delete-cancel' } as object, children),
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

let root: Root;
let container: HTMLElement;
let finish: (result: { ok: boolean; error?: string }) => void;
const onOpenChange = vi.fn();
const onDeleted = vi.fn();
const button = (name: string) =>
  container.querySelector(`[data-enso="${name}"]`) as HTMLButtonElement | null;

beforeEach(async () => {
  onOpenChange.mockReset();
  onDeleted.mockReset();
  const { window } = parseHTML('<html><body><div id="root"></div></body></html>');
  vi.stubGlobal('window', window);
  vi.stubGlobal('document', window.document);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  Object.assign(window, {
    electronAPI: {
      secretary: {
        deletePreview: async () => ({
          ok: true,
          preview: { name: 'B', sessions: [], todos: [], schedules: [], contacts: [], memories: 0 },
        }),
        deleteSecretary: () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      },
    },
  });
  container = window.document.getElementById('root') as unknown as HTMLElement;
  root = createRoot(container);
  await act(async () =>
    root.render(
      <SecretaryDeleteDialog
        open
        secretaryId="s-b"
        onOpenChange={onOpenChange}
        onDeleted={onDeleted}
      />
    )
  );
  await act(async () => button('secretary-delete-next')?.click());
});

afterEach(async () => {
  await act(async () => root.unmount());
  vi.unstubAllGlobals();
});

describe('删除秘书弹窗：进行中反馈', () => {
  it('删除进行中按钮显示「删除中…」并禁用，取消与关闭都不生效', async () => {
    await act(async () => button('secretary-delete-confirm')?.click());
    const confirm = button('secretary-delete-confirm');
    expect(confirm?.textContent).toBe('Deleting…');
    expect(confirm?.disabled).toBe(true);
    expect(button('secretary-delete-cancel')?.disabled).toBe(true);
    await act(async () => dialog.onOpenChange?.(false));
    expect(onOpenChange).not.toHaveBeenCalled();

    await act(async () => finish({ ok: true }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(onDeleted).toHaveBeenCalledTimes(1);
  });

  it('删除成功后弹窗关闭动画期间仍是「删除中…」，不会闪回可点的「永久删除」；再次打开才复位', async () => {
    await act(async () => button('secretary-delete-confirm')?.click());
    await act(async () => finish({ ok: true }));
    // 父组件已收到 onOpenChange(false)，但关闭动画还没放完，弹窗仍在屏上
    expect(button('secretary-delete-confirm')?.textContent).toBe('Deleting…');
    expect(button('secretary-delete-confirm')?.disabled).toBe(true);
    expect(button('secretary-delete-cancel')?.disabled).toBe(true);

    const render = (open: boolean) =>
      root.render(
        <SecretaryDeleteDialog
          open={open}
          secretaryId="s-b"
          onOpenChange={onOpenChange}
          onDeleted={onDeleted}
        />
      );
    await act(async () => render(false));
    await act(async () => render(true));
    await act(async () => button('secretary-delete-next')?.click());
    expect(button('secretary-delete-confirm')?.textContent).toBe('Delete permanently');
    expect(button('secretary-delete-confirm')?.disabled).toBe(false);
  });

  it('删除失败时恢复按钮并显示错误', async () => {
    await act(async () => button('secretary-delete-confirm')?.click());
    await act(async () => finish({ ok: false, error: 'disk full' }));
    expect(button('secretary-delete-confirm')?.textContent).toBe('Delete permanently');
    expect(button('secretary-delete-confirm')?.disabled).toBe(false);
    expect(container.textContent).toContain('disk full');
    expect(onDeleted).not.toHaveBeenCalled();
  });

  it('「删除中…」有中文', () => {
    expect(getTranslation('zh', 'Deleting…')).toBe('删除中…');
  });
});
