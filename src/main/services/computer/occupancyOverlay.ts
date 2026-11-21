import { app, BrowserWindow, globalShortcut, screen } from 'electron';
import { showOnAllSpaces } from './floatingWindow';
import type { OccupancyDeps } from './occupancy';
import { hidSecondsSinceLastEvent } from './occupancyHid';

const BAR_HEIGHT = 44;
const BAR_COLOR = '#147ce5';

function bannerHtml(): string {
  const zh = app.getLocale().toLowerCase().startsWith('zh');
  const name = app.getName() || 'EnsoCode';
  const title = zh ? `${name} 正在使用你的电脑` : `${name} is using your computer`;
  const hint = zh ? 'Esc 取消' : 'Esc to cancel';
  return (
    '<!doctype html><html><body style="margin:0;height:100vh;display:flex;align-items:center;justify-content:center;gap:16px;' +
    `background:${BAR_COLOR};font:600 15px/1.2 -apple-system,BlinkMacSystemFont,sans-serif;color:#fff;` +
    'letter-spacing:.01em;user-select:none;-webkit-font-smoothing:antialiased">' +
    `<span>${title}</span>` +
    `<span style="font-weight:500;font-size:13px;opacity:.85">${hint}</span>` +
    '</body></html>'
  );
}

function layout(win: BrowserWindow): void {
  const area = screen.getPrimaryDisplay().workArea;
  win.setBounds({ x: area.x, y: area.y, width: area.width, height: BAR_HEIGHT });
}

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    show: false,
    frame: false,
    backgroundColor: BAR_COLOR,
    // macOS: skipTaskbar 会把整个 App 改成 accessory，Dock 图标消失。
    skipTaskbar: process.platform !== 'darwin',
    focusable: false,
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    hasShadow: false,
    alwaysOnTop: true,
    width: 800,
    height: BAR_HEIGHT,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
  });
  win.setAlwaysOnTop(true, 'screen-saver');
  showOnAllSpaces(win);
  win.setIgnoreMouseEvents(true);
  win.setContentProtection(true);
  void win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(bannerHtml())}`);
  return win;
}

export function createElectronOccupancyDeps(): OccupancyDeps {
  let win: BrowserWindow | null = null;
  return {
    show: () => {
      if (!win || win.isDestroyed()) win = createWindow();
      layout(win);
      win.showInactive();
    },
    hide: () => {
      if (win && !win.isDestroyed()) win.hide();
    },
    registerEsc: (handler) => {
      if (!globalShortcut.register('Escape', handler)) {
        console.warn('[computer] Escape hotkey registration failed; Esc cancel unavailable');
        return () => {};
      }
      return () => globalShortcut.unregister('Escape');
    },
    hidSeconds: hidSecondsSinceLastEvent,
  };
}
