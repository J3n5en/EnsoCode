import { parseHTML } from 'linkedom';
import { act, type ReactElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ZoomableImage } from './ZoomableImage';

const harness = vi.hoisted(() => ({ toast: vi.fn(), write: vi.fn() }));
vi.mock('@/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock('@/components/ui/toast', () => ({ addToast: harness.toast }));
vi.mock('@/hooks/useOverlayGuard', () => ({ useOverlayGuard: () => {} }));
vi.mock('@/components/ui/context-menu', async () => {
  const { cloneElement } = await import('react');
  return {
    ContextMenu: ({ children }: { children: ReactNode }) => <span>{children}</span>,
    ContextMenuTrigger: ({ render }: { render: ReactElement }) => cloneElement(render),
    ContextMenuPopup: ({ children }: { children: ReactNode }) => (
      <span role="menu">{children}</span>
    ),
    ContextMenuItem: ({ children, onClick }: { children: ReactNode; onClick: () => void }) => (
      <button type="button" role="menuitem" onClick={onClick}>
        {children}
      </button>
    ),
  };
});

class FakeClipboardItem {
  constructor(readonly items: Record<string, Blob>) {}
}

let root: Root;
let container: HTMLElement;

async function copy(src: string) {
  await act(async () => root.render(<ZoomableImage src={src} />));
  await act(async () => {
    container
      .querySelector('[role="menuitem"]')
      ?.dispatchEvent(new window.Event('click', { bubbles: true }));
  });
  await vi.waitFor(() => expect(harness.toast).toHaveBeenCalled());
}

beforeEach(() => {
  const dom = parseHTML('<html><body><div id="root"></div></body></html>');
  vi.stubGlobal('window', dom.window);
  vi.stubGlobal('document', dom.document);
  vi.stubGlobal('navigator', { clipboard: { write: harness.write } });
  vi.stubGlobal('ClipboardItem', FakeClipboardItem);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  container = dom.document.getElementById('root') as unknown as HTMLElement;
  root = createRoot(container);
  vi.clearAllMocks();
  harness.write.mockResolvedValue(undefined);
});

afterEach(async () => {
  await act(async () => root.unmount());
  vi.unstubAllGlobals();
});

describe('消息图片右键复制', () => {
  it('PNG data URL 原样解码写入剪贴板', async () => {
    await copy('data:image/png;base64,AQID');
    const [[items]] = harness.write.mock.calls as [[FakeClipboardItem[]]];
    const png = items[0].items['image/png'];
    expect([...new Uint8Array(await png.arrayBuffer())]).toEqual([1, 2, 3]);
    expect(harness.toast).toHaveBeenCalledWith(expect.objectContaining({ type: 'success' }));
  });

  it('非 PNG 先转码为 PNG', async () => {
    const converted = new Blob(['png'], { type: 'image/png' });
    vi.stubGlobal(
      'createImageBitmap',
      vi.fn(async () => ({ width: 2, height: 1, close: () => {} }))
    );
    vi.stubGlobal(
      'OffscreenCanvas',
      class {
        getContext = () => ({ drawImage: () => {} });
        convertToBlob = async () => converted;
      }
    );
    await copy('data:image/jpeg;base64,AQID');
    const [[items]] = harness.write.mock.calls as [[FakeClipboardItem[]]];
    expect(items[0].items['image/png']).toBe(converted);
  });

  it('剪贴板失败给出错误提示', async () => {
    harness.write.mockRejectedValue(new Error('denied'));
    await copy('data:image/png;base64,AQID');
    expect(harness.toast).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'error', description: 'denied' })
    );
  });
});
