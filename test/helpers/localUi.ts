import type { RendererContents } from '../../src/main/platform/types';
import type { LocalUi } from '../../src/main/services/uiHost';

interface FakeWindow {
  isDestroyed(): boolean;
  webContents: Pick<RendererContents, 'send'> & Partial<RendererContents>;
}

/** 用一组假窗口充当桌面本地界面：广播发给各窗口 webContents，主窗口可选 */
export function fakeLocalUi(
  windows: () => FakeWindow[],
  overrides: Partial<LocalUi> = {}
): LocalUi {
  const contents = () =>
    windows()
      .filter((win) => !win.isDestroyed())
      .map((win) => win.webContents as RendererContents)
      .filter((wc) => !wc.isDestroyed?.());
  return {
    mainContents: () => null,
    settingsContents: () => null,
    allContents: contents,
    windowContentIds: () => contents().map((wc) => wc.id),
    onWindowClosed() {},
    anyFocused: () => false,
    inputIdleMs: () => Number.POSITIVE_INFINITY,
    focusMain() {},
    chromiumRenderers: () => ({
      mainPids: new Set(),
      settingsPids: new Set(),
      browserPids: new Set(),
      titles: new Map(),
    }),
    trayMode: () => false,
    ...overrides,
  };
}

/** vi.mock 工厂：resetModules 后重新求值仍指向同一组假窗口 */
export function mockUiHost(windows: () => FakeWindow[], overrides: Partial<LocalUi> = {}) {
  const ui = fakeLocalUi(windows, overrides);
  return { installLocalUi() {}, localUi: () => ui };
}
