import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import {
  FALLBACK_TRAY_ICON_DATA_URL,
  firstExistingPath,
  isTrayTemplatePath,
  shouldStayAliveOnWindowAllClosed,
  trayClickAction,
  trayIconCandidates,
} from '@shared/appServerMode';
import { IPC_CHANNELS } from '@shared/types';
import { app, ipcMain, Menu, nativeImage, Tray } from 'electron';
import {
  flushSettings,
  readSettings,
  readTrayPreventDisplaySleep,
  readTraySleepPolicy,
  writeTrayPreventDisplaySleep,
  writeTraySleepPolicy,
} from '../ipc/settings';
import {
  closeWindowWebContents,
  getWindowWebContents,
  sendToWindow,
} from '../windows/createAppWindow';
import { createMainWindow, getMainWindow, isMainWindowAlive } from '../windows/MainWindow';
import { getSettingsWindow } from '../windows/SettingsWindow';
import { allowAppQuit, bypassNextCloseConfirm } from './appCloseConfirm';
import { browserHost } from './browserHost';
import { refreshPowerKeepAlive } from './pairHost';
import { setPairHeadless } from './pairSessionHost';

const FLUSH_TIMEOUT_MS = 5_000;
const REENTER_FALLBACK_MS = 8_000;

let active = false;
/** 进/出托盘的切换代次：enter 中途有 await，期间被唤回或重入时旧的 enter 必须作废 */
let transition = 0;
let tray: Tray | null = null;

export function isServerMode(): boolean {
  return active;
}

export function shouldQuitOnWindowAllClosed(platform: NodeJS.Platform): boolean {
  return !shouldStayAliveOnWindowAllClosed({ serverMode: active, platform });
}

function languageIsZh(): boolean {
  const settings = readSettings()?.['enso-settings'] as
    | { state?: { language?: unknown } }
    | undefined;
  return settings?.state?.language === 'zh';
}

function trayIcon() {
  const file = firstExistingPath(
    trayIconCandidates({
      appPath: app.getAppPath(),
      resourcesPath: process.resourcesPath,
      moduleDir: import.meta.dirname,
      cwd: process.cwd(),
      platform: process.platform,
    }),
    existsSync
  );
  let image = file ? nativeImage.createFromPath(file) : nativeImage.createEmpty();
  if (image.isEmpty()) image = nativeImage.createFromDataURL(FALLBACK_TRAY_ICON_DATA_URL);
  const template = Boolean(file && isTrayTemplatePath(file));
  if (!template) {
    const { width } = image.getSize();
    if (width > 32 || width < 16) image = image.resize({ width: 16, height: 16 });
  }
  if (process.platform === 'darwin' && (template || !file)) image.setTemplateImage(true);
  return image;
}

function trayToggleLabel(zh: boolean): string {
  if (trayClickAction(active) === 'show') return zh ? '打开 EnsoCode' : 'Show EnsoCode';
  return zh ? '最小化到托盘' : 'Minimize to tray';
}

function rebuildTrayMenu(): void {
  if (!tray) return;
  const zh = languageIsZh();
  const sleepPolicy = readTraySleepPolicy();
  const preventDisplaySleep = readTrayPreventDisplaySleep();
  tray.setContextMenu(
    Menu.buildFromTemplate([
      {
        label: trayToggleLabel(zh),
        click: () => handleTrayActivate(),
      },
      { type: 'separator' },
      {
        label: zh ? '有 Agent 运行时不休眠' : 'Prevent sleep while agent is running',
        type: 'radio',
        checked: sleepPolicy === 'when-agent-running',
        click: () => {
          writeTraySleepPolicy('when-agent-running');
          refreshPowerKeepAlive();
          rebuildTrayMenu();
        },
      },
      {
        label: zh ? '永远不休眠' : 'Never sleep',
        type: 'radio',
        checked: sleepPolicy === 'never',
        click: () => {
          writeTraySleepPolicy('never');
          refreshPowerKeepAlive();
          rebuildTrayMenu();
        },
      },
      { type: 'separator' },
      {
        label: zh ? '不休眠时阻止息屏' : 'Keep the screen on while awake',
        type: 'checkbox',
        checked: preventDisplaySleep,
        click: () => {
          writeTrayPreventDisplaySleep(!preventDisplaySleep);
          refreshPowerKeepAlive();
          rebuildTrayMenu();
        },
      },
      { type: 'separator' },
      {
        label: zh ? '退出' : 'Quit',
        click: () => quitFromTray(),
      },
    ])
  );
  tray.setToolTip('EnsoCode');
}

function handleTrayActivate(): void {
  if (trayClickAction(active) === 'show') leaveServerMode();
  else void enterServerMode();
}

export function ensureTray(): void {
  if (tray && !tray.isDestroyed()) {
    rebuildTrayMenu();
    return;
  }
  tray = new Tray(trayIcon());
  tray.on('click', () => handleTrayActivate());
  rebuildTrayMenu();
}

function recreateTray(): void {
  if (tray && !tray.isDestroyed()) tray.destroy();
  tray = null;
  ensureTray();
}

export async function flushRendererPersist(): Promise<void> {
  const win = getMainWindow();
  if (!win || win.isDestroyed()) return;
  const contents = getWindowWebContents(win);
  if (contents.isDestroyed()) return;
  const requestId = randomUUID();
  await new Promise<void>((resolve) => {
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      ipcMain.removeListener(IPC_CHANNELS.APP_FLUSH_PERSIST_RESPONSE, onResponse);
      resolve();
    };
    const onResponse = (_event: Electron.IpcMainEvent, incomingId: unknown) => {
      if (incomingId === requestId) done();
    };
    const timer = setTimeout(done, FLUSH_TIMEOUT_MS);
    ipcMain.on(IPC_CHANNELS.APP_FLUSH_PERSIST_RESPONSE, onResponse);
    sendToWindow(win, IPC_CHANNELS.APP_FLUSH_PERSIST_REQUEST, requestId);
  });
}

export async function enterServerMode(): Promise<void> {
  if (active) return;
  const epoch = ++transition;
  await flushRendererPersist();
  if (epoch !== transition) return;
  flushSettings();
  active = true;
  setPairHeadless(true);
  bypassNextCloseConfirm();
  refreshPowerKeepAlive();
  const settings = getSettingsWindow();
  if (settings && !settings.isDestroyed()) settings.close();
  ensureTray();
  await browserHost.hibernateAll();
  // 等待期间用户已唤回（Dock / 托盘 / 快捷键 / 二次启动）：不能再销毁窗口、隐藏 Dock
  if (epoch !== transition) return;
  const win = getMainWindow();
  if (win && !win.isDestroyed()) {
    closeWindowWebContents(win);
    win.destroy();
  }
  app.dock?.hide();
  // dock.hide() 会把 activation policy 改成 accessory，已有 NSStatusItem 经常被丢掉。
  recreateTray();
}

export function leaveServerMode(): void {
  transition++;
  active = false;
  setPairHeadless(false);
  flushSettings();
  app.dock?.show();
  if (!isMainWindowAlive()) createMainWindow();
  const win = getMainWindow();
  if (win && !win.isDestroyed()) {
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  }
  ensureTray();
}

export function quitFromTray(): void {
  allowAppQuit();
  app.quit();
}

export function restoreFromSecondInstance(): void {
  leaveServerMode();
}

/** 更新安装后冷启动：等 renderer 把目录推来再进托盘，避免 headless 种子是空的。 */
export function scheduleReenterServerMode(): void {
  let entered = false;
  const enter = () => {
    if (entered || active) return;
    entered = true;
    ipcMain.removeListener(IPC_CHANNELS.PAIR_CATALOG, onCatalog);
    clearTimeout(timer);
    void enterServerMode();
  };
  const onCatalog = () => enter();
  ipcMain.on(IPC_CHANNELS.PAIR_CATALOG, onCatalog);
  const timer = setTimeout(enter, REENTER_FALLBACK_MS);
}
