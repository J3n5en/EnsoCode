import { app, BrowserWindow, session, type WebContents, webContents } from 'electron';
import { isServerMode } from '../services/appServerMode';
import { partitionName } from '../services/browserPartition';
import { isMainRenderer, isSettingsRenderer } from '../services/renderers';
import { type ChromiumRendererInfo, installLocalUi, type LocalUi } from '../services/uiHost';
import { getWindowWebContents, getWorkbenchView } from '../windows/createAppWindow';
import { focusMainWindow, getMainWindow } from '../windows/MainWindow';
import { getSettingsWindow } from '../windows/SettingsWindow';

const windowClosed = new Set<(webContentsId: number) => void>();

function contentsOf(win: Electron.BrowserWindow): WebContents {
  return getWindowWebContents(win);
}

function alive(contents: WebContents | null | undefined): contents is WebContents {
  return Boolean(contents && !contents.isDestroyed());
}

function chromiumRenderers(): ChromiumRendererInfo {
  const browserSession = session.fromPartition(partitionName(app.isPackaged));
  const mainPids = new Set<number>();
  const settingsPids = new Set<number>();
  const browserPids = new Set<number>();
  const titles = new Map<number, string>();
  for (const contents of webContents.getAllWebContents()) {
    if (contents.isDestroyed()) continue;
    const pid = contents.getOSProcessId();
    if (pid <= 0) continue;
    if (isMainRenderer(contents.id)) mainPids.add(pid);
    else if (isSettingsRenderer(contents.id)) settingsPids.add(pid);
    else if (contents.session === browserSession) browserPids.add(pid);
    const title = contents.getTitle() || contents.getURL();
    if (title && !titles.has(pid)) titles.set(pid, title);
  }
  return { mainPids, settingsPids, browserPids, titles };
}

const desktopUi: LocalUi = {
  mainContents() {
    const win = getMainWindow();
    if (!win || win.isDestroyed()) return null;
    const contents = contentsOf(win);
    return alive(contents) ? contents : null;
  },
  settingsContents() {
    const win = getSettingsWindow();
    if (!win || win.isDestroyed() || win.webContents.isDestroyed()) return null;
    return win.webContents;
  },
  allContents() {
    return BrowserWindow.getAllWindows()
      .filter((win) => !win.isDestroyed())
      .map(contentsOf)
      .filter(alive);
  },
  windowContentIds() {
    return BrowserWindow.getAllWindows()
      .filter((win) => !win.isDestroyed() && !win.webContents.isDestroyed())
      .map((win) => win.webContents.id);
  },
  onWindowClosed(listener) {
    windowClosed.add(listener);
  },
  anyFocused() {
    return BrowserWindow.getAllWindows().some((win) => !win.isDestroyed() && win.isFocused());
  },
  focusMain() {
    focusMainWindow();
  },
  chromiumRenderers,
  trayMode: isServerMode,
};

export function installDesktopLocalUi(): void {
  installLocalUi(desktopUi);
  app.on('browser-window-created', (_event, window) => {
    // closed 时窗口已销毁，win.webContents 会抛错，外壳 id 只能在这里取
    const webContentsId = window.webContents.id;
    window.once('closed', () => {
      const ids = new Set([webContentsId]);
      // 主窗口 UI 在 pinned WebContentsView 里，询问等归属记的是它的 id。创建事件触发时 view
      // 还没挂上，要到 closed 再取：此时 view 的 webContents 尚未销毁（随后才销毁）；若已先销毁，
      // 运行时取到的是 undefined
      const ui = getWorkbenchView(window)?.webContents;
      if (ui && !ui.isDestroyed()) ids.add(ui.id);
      for (const id of ids) for (const listener of windowClosed) listener(id);
    });
  });
}
