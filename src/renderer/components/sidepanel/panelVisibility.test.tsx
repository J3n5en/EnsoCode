import { parseHTML } from 'linkedom';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type PanelActivitySource,
  PanelVisibilityProvider,
  usePanelHotkeyTarget,
  usePanelVisibility,
} from './panelVisibility';

const harness = vi.hoisted(() => ({
  sessions: { activeId: 'a' as string | null },
  sidePanel: { uiByConversation: {} as Record<string, { open: boolean; width: number }> },
}));
vi.mock('@/stores/sessions', () => ({
  useSessionsStore: (select: (state: unknown) => unknown) => select(harness.sessions),
}));
vi.mock('@/stores/sidePanel', () => ({
  useSidePanelStore: (select: (state: unknown) => unknown) => select(harness.sidePanel),
}));

/** dockview 面板 api 的替身：可随时改 isActive / isVisible 并广播 */
function fakePanelApi(initial: { isActive: boolean; isVisible: boolean }) {
  const listeners = new Set<() => void>();
  const subscribe = (listener: () => void) => {
    listeners.add(listener);
    return { dispose: () => listeners.delete(listener) };
  };
  const api = {
    ...initial,
    onDidActiveChange: subscribe,
    onDidVisibilityChange: subscribe,
    set(next: { isActive: boolean; isVisible: boolean }) {
      Object.assign(api, next);
      for (const listener of listeners) listener();
    },
  };
  return api satisfies PanelActivitySource;
}

function Probe({ enabled = true }: { enabled?: boolean }) {
  const { visible, active } = usePanelVisibility();
  const hotkey = usePanelHotkeyTarget('files', enabled);
  return (
    <i data-visible={String(visible)} data-active={String(active)} data-hotkey={String(hotkey)} />
  );
}

let root: Root;
let container: HTMLElement;
const probe = () => {
  const el = container.querySelector('i');
  return {
    visible: el?.getAttribute('data-visible'),
    active: el?.getAttribute('data-active'),
    hotkey: el?.getAttribute('data-hotkey'),
  };
};
async function mount(api: PanelActivitySource, dockConversationId = 'a') {
  await act(async () =>
    root.render(
      <PanelVisibilityProvider dockConversationId={dockConversationId} api={api}>
        <Probe />
      </PanelVisibilityProvider>
    )
  );
}

beforeEach(() => {
  const dom = parseHTML('<html><body><div id="root"></div></body></html>');
  vi.stubGlobal('window', dom.window);
  vi.stubGlobal('document', dom.document);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  harness.sessions.activeId = 'a';
  harness.sidePanel.uiByConversation = { a: { open: true, width: 400 } };
  container = dom.document.getElementById('root') as unknown as HTMLElement;
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  vi.unstubAllGlobals();
});

describe('侧栏面板可见性', () => {
  // dock 按会话常驻：切到别的会话后，原会话的面板仍挂载但已被隐藏
  it('所在 dock 不是当前会话时，面板既不可见也不激活', async () => {
    harness.sessions.activeId = 'b';
    await mount(fakePanelApi({ isActive: true, isVisible: true }));
    expect(probe()).toEqual({ visible: 'false', active: 'false', hotkey: 'false' });
  });

  it('侧栏收起时，当前会话的面板也不算可见', async () => {
    harness.sidePanel.uiByConversation = { a: { open: false, width: 400 } };
    await mount(fakePanelApi({ isActive: true, isVisible: true }));
    expect(probe()).toEqual({ visible: 'false', active: 'false', hotkey: 'false' });
  });

  it('分屏时所在分组未激活：面板仍可见，唯一可见时照样接管快捷键', async () => {
    await mount(fakePanelApi({ isActive: false, isVisible: true }));
    expect(probe()).toEqual({ visible: 'true', active: 'false', hotkey: 'true' });
  });

  it('dockview 切走 tab 再切回时跟随更新', async () => {
    const api = fakePanelApi({ isActive: true, isVisible: true });
    await mount(api);
    expect(probe()).toEqual({ visible: 'true', active: 'true', hotkey: 'true' });
    await act(async () => api.set({ isActive: false, isVisible: false }));
    expect(probe()).toEqual({ visible: 'false', active: 'false', hotkey: 'false' });
    await act(async () => api.set({ isActive: true, isVisible: true }));
    expect(probe()).toEqual({ visible: 'true', active: 'true', hotkey: 'true' });
  });

  it('不在侧栏 dock 里（如 Bot 面板）时按可见且激活处理', async () => {
    await act(async () => root.render(<Probe />));
    expect(probe()).toEqual({ visible: 'true', active: 'true', hotkey: 'true' });
  });

  it('同时有两个可见的同种面板时，只让激活的那个接管快捷键', async () => {
    const left = fakePanelApi({ isActive: false, isVisible: true });
    const right = fakePanelApi({ isActive: true, isVisible: true });
    await act(async () =>
      root.render(
        <>
          <PanelVisibilityProvider dockConversationId="a" api={left}>
            <Probe />
          </PanelVisibilityProvider>
          <section data-peer="">
            <PanelVisibilityProvider dockConversationId="a" api={right}>
              <Probe />
            </PanelVisibilityProvider>
          </section>
        </>
      )
    );
    const flags = () =>
      [...container.querySelectorAll('i')].map((el) => el.getAttribute('data-hotkey'));
    expect(flags()).toEqual(['false', 'true']);
    await act(async () => {
      right.set({ isActive: false, isVisible: true });
      left.set({ isActive: true, isVisible: true });
    });
    expect(flags()).toEqual(['true', 'false']);
  });

  it('隐藏会话的同种面板不算第二个可见面板，当前这个即使分组未激活也接管', async () => {
    await act(async () =>
      root.render(
        <>
          <PanelVisibilityProvider
            dockConversationId="a"
            api={fakePanelApi({ isActive: false, isVisible: true })}
          >
            <Probe />
          </PanelVisibilityProvider>
          <PanelVisibilityProvider
            dockConversationId="b"
            api={fakePanelApi({ isActive: true, isVisible: true })}
          >
            <Probe />
          </PanelVisibilityProvider>
        </>
      )
    );
    const flags = () =>
      [...container.querySelectorAll('i')].map((el) => el.getAttribute('data-hotkey'));
    expect(flags()).toEqual(['true', 'false']);
  });

  it('宿主自管快捷键的面板（如 Bot 浏览器）不登记，不挤掉侧栏里唯一可见的同种面板', async () => {
    await act(async () =>
      root.render(
        <>
          <PanelVisibilityProvider
            dockConversationId="a"
            api={fakePanelApi({ isActive: false, isVisible: true })}
          >
            <Probe />
          </PanelVisibilityProvider>
          <Probe enabled={false} />
        </>
      )
    );
    const flags = () =>
      [...container.querySelectorAll('i')].map((el) => el.getAttribute('data-hotkey'));
    expect(flags()).toEqual(['true', 'false']);
  });
});
