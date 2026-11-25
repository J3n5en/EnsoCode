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
import { translate } from '@shared/i18n';
import { IPC_CHANNELS } from '@shared/types/ipc';
import {
  app,
  type BrowserWindow,
  ipcMain,
  Menu,
  type MenuItemConstructorOptions,
  nativeImage,
  Tray,
} from 'electron';
import {
  flushSettings,
  readSettings,
  readTrayPreventDisplaySleep,
  readTraySleepPolicy,
  writeTrayPreventDisplaySleep,
  writeTrayReenterAfterUpdate,
  writeTraySleepPolicy,
} from '../ipc/settings';
import {
  closeWindowWebContents,
  getWindowWebContents,
  sendToWindow,
} from '../windows/createAppWindow';
import { createMainWindow, getMainWindow, isMainWindowAlive } from '../windows/MainWindow';
import { openSettingsInMainWindow } from '../windows/mainSettings';
import { isVerifyLaunch, presentWindow } from '../windows/verifyLaunch';
import { allowAppQuit, destroyWithoutCloseConfirm } from './appCloseConfirm';
import type { AppRestartState } from './appRestart';
import { browserHost } from './browserHost';
import { refreshPowerKeepAlive } from './pairHost';
import { setPairHeadless } from './pairSessionHost';

const FLUSH_TIMEOUT_MS = 5_000;
const REENTER_FALLBACK_MS = 8_000;

let active = false;
/** 进/出托盘的切换代次：enter 中途有 await，期间被唤回或重入时旧的 enter 必须作废 */
let transition = 0;
let tray: Tray | null = null;
const watchedWindows = new WeakSet<BrowserWindow>();

/** 托盘「重启」由 Main 入口注入，与应用菜单共用同一个 appRestart（先 relaunch 再退出，只登记一次） */
export interface TrayRestartActions {
  restartApp(): void;
  restartState(): AppRestartState;
  reportError?(message: string): void;
}

let trayRestart: TrayRestartActions | undefined;

export function setTrayRestartActions(actions: TrayRestartActions): void {
  trayRestart = actions;
}

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

/** 以窗口实际状态为准：被 computer、⌘H、最小化或 Dock 策略变化藏起都算不在前台 */
function mainWindowShown(): boolean {
  if (active) return false;
  const win = getMainWindow();
  if (!win || win.isDestroyed() || !win.isVisible() || win.isMinimized()) return false;
  return app.dock ? app.dock.isVisible() : true;
}

function currentTrayAction() {
  return trayClickAction({ serverMode: active, windowShown: mainWindowShown() });
}

function trayToggleLabel(zh: boolean): string {
  if (currentTrayAction() === 'show') return zh ? '打开 EnsoCode' : 'Show EnsoCode';
  return zh ? '最小化到托盘' : 'Minimize to tray';
}

function trayRestartItems(zh: boolean): MenuItemConstructorOptions[] {
  if (!trayRestart) return [];
  switch (trayRestart.restartState()) {
    case 'waiting-for-tools':
      return [
        {
          label: zh ? '等命令跑完再重启…' : 'Waiting for running commands to restart…',
          enabled: false,
        },
      ];
    case 'restarting':
      return [{ label: zh ? '正在重启…' : 'Restarting…', enabled: false }];
    default:
      return [{ label: zh ? '重启' : 'Restart', click: () => restartFromTray() }];
  }
}

export function rebuildTrayMenu(): void {
  if (!tray || tray.isDestroyed()) return;
  const zh = languageIsZh();
  const sleepPolicy = readTraySleepPolicy();
  const preventDisplaySleep = readTrayPreventDisplaySleep();
  tray.setContextMenu(
    Menu.buildFromTemplate([
      {
        label: trayToggleLabel(zh),
        click: () => toggleTrayMode(),
      },
      {
        label: zh ? '设置…' : 'Settings…',
        click: () => openSettingsInMainWindow(),
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
      ...trayRestartItems(zh),
      {
        label: zh ? '退出' : 'Quit',
        click: () => quitFromTray(),
      },
    ])
  );
  tray.setToolTip('EnsoCode');
}

/** 托盘点击、菜单项与全局快捷键共用：按实际可见性切换 */
export function toggleTrayMode(): void {
  if (currentTrayAction() === 'show') leaveServerMode();
  else void enterServerMode();
}

/** 菜单是静态快照：窗口显隐变化时重建，保证切换项文案跟随实际状态 */
function watchMainWindow(): void {
  const win = getMainWindow();
  if (!win || win.isDestroyed() || watchedWindows.has(win)) return;
  watchedWindows.add(win);
  const refresh = () => rebuildTrayMenu();
  win.on('show', refresh);
  win.on('hide', refresh);
  win.on('minimize', refresh);
  win.on('restore', refresh);
}

export function ensureTray(): void {
  watchMainWindow();
  if (tray && !tray.isDestroyed()) {
    rebuildTrayMenu();
    return;
  }
  tray = new Tray(trayIcon());
  tray.on('click', () => toggleTrayMode());
  // Dock 策略被改（不派发窗口事件）时，鼠标移到图标上就按当前状态重建菜单
  tray.on('mouse-enter', () => rebuildTrayMenu());
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
  refreshPowerKeepAlive();
  ensureTray();
  await browserHost.hibernateAll();
  // 等待期间用户已唤回（Dock / 托盘 / 快捷键 / 二次启动）：不能再销毁窗口、隐藏 Dock
  if (epoch !== transition) return;
  const win = getMainWindow();
  if (win && !win.isDestroyed()) {
    // 放行只覆盖这次同步销毁：上面的提前 return 不留标志，也不会漏给唤回后的新窗口
    destroyWithoutCloseConfirm(() => {
      closeWindowWebContents(win);
      win.destroy();
    });
  }
  app.dock?.hide();
  // dock.hide() 会把 activation policy 改成 accessory，已有 NSStatusItem 经常被丢掉。
  recreateTray();
}

export function leaveServerMode(): void {
  transition++;
  const wasActive = active;
  active = false;
  setPairHeadless(false);
  if (wasActive) writeTrayReenterAfterUpdate(false);
  flushSettings();
  if (!isVerifyLaunch()) app.dock?.show();
  if (!isMainWindowAlive()) createMainWindow();
  const win = getMainWindow();
  if (win && !win.isDestroyed()) presentWindow(win);
  ensureTray();
}

export function quitFromTray(): void {
  allowAppQuit();
  app.quit();
}

export function restartFromTray(): void {
  if (trayRestart?.restartState() !== 'idle') return;
  // 托盘模式下重启：新实例冷启动等 renderer 推来目录后回到托盘，与更新后重启同一机制
  const reenter = active;
  if (reenter) {
    writeTrayReenterAfterUpdate(true);
    flushSettings();
  }
  try {
    trayRestart.restartApp();
  } catch (error) {
    if (reenter) {
      writeTrayReenterAfterUpdate(false);
      flushSettings();
    }
    console.error('[tray] 重启失败:', error);
    const reason = error instanceof Error ? error.message : String(error);
    trayRestart.reportError?.(
      translate(languageIsZh() ? 'zh' : 'en', 'Restart failed: {{error}}', { error: reason })
    );
  }
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
