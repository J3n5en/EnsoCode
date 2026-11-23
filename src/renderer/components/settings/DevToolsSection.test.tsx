import { parseHTML } from 'linkedom';
import { act, type ComponentProps } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DevToolsSection } from './DevToolsSection';

const harness = vi.hoisted(() => ({ openDevTools: vi.fn(), toast: vi.fn() }));
vi.mock('@/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock('@/components/ui/toast', () => ({ addToast: harness.toast }));
vi.mock('@/components/ui/button', () => ({
  Button: ({
    variant: _variant,
    size: _size,
    ...props
  }: ComponentProps<'button'> & { variant?: string; size?: string }) => (
    <button type="button" {...props} />
  ),
}));

let root: Root;
let container: HTMLElement;

const mount = async (remote: boolean) => {
  const dom = parseHTML('<html><body><div id="root"></div></body></html>');
  vi.stubGlobal('window', dom.window);
  vi.stubGlobal('document', dom.document);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  Object.assign(dom.window, {
    electronAPI: { remote, window: { openDevTools: harness.openDevTools } },
  });
  container = dom.document.getElementById('root') as unknown as HTMLElement;
  root = createRoot(container);
  await act(async () => root.render(<DevToolsSection />));
};
const openButton = () =>
  [...container.querySelectorAll('button')].find((b) => b.textContent === 'Open');

beforeEach(() => {
  vi.clearAllMocks();
  harness.openDevTools.mockResolvedValue({ ok: true });
});
afterEach(async () => {
  await act(async () => root.unmount());
  vi.unstubAllGlobals();
});

describe('DevToolsSection', () => {
  it('点「打开」调用 openDevTools IPC，成功不弹错误', async () => {
    await mount(false);
    expect(container.textContent).toContain('Developer tools');
    await act(async () => openButton()?.click());
    expect(harness.openDevTools).toHaveBeenCalledTimes(1);
    expect(harness.openDevTools).toHaveBeenCalledWith();
    expect(harness.toast).not.toHaveBeenCalled();
  });

  it('主窗口不在时给出可读错误', async () => {
    harness.openDevTools.mockResolvedValueOnce({ ok: false, error: 'main-window-unavailable' });
    await mount(false);
    await act(async () => openButton()?.click());
    expect(harness.toast).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'error',
        description: 'The main window is closed. Open it and try again.',
      })
    );
  });

  it('远程客户端不显示入口', async () => {
    await mount(true);
    expect(container.textContent).not.toContain('Developer tools');
    expect(openButton()).toBeUndefined();
    expect(harness.openDevTools).not.toHaveBeenCalled();
  });

  it('IPC 抛错时弹错误提示，不产生未捕获异常', async () => {
    harness.openDevTools.mockRejectedValueOnce(new Error('ipc failed'));
    await mount(false);
    await act(async () => openButton()?.click());
    expect(harness.toast).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'error',
        description: 'ipc failed',
      })
    );
  });
});
