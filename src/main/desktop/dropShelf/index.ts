import { stat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { ipcMain } from '@platform';
import type { DragWatchState, DropShelfDelivery, DropShelfLayout } from '@shared/dropShelf';
import {
  DROP_SHELF_MAX_PATHS,
  dropShelfBounds,
  dropShelfLayout,
  parseDropShelfDrop,
  stepDragWatch,
} from '@shared/dropShelf';
import { translate } from '@shared/i18n';
import { IPC_CHANNELS } from '@shared/types';
import { app, BrowserWindow, screen, systemPreferences } from 'electron';
import { readLocale } from '../../ipc/settings';
import { isServerMode, leaveServerMode } from '../../services/appServerMode';
import { localMainContents } from '../../services/renderers';
import { sendToWindow } from '../../windows/createAppWindow';
import { focusMainWindow, getMainWindow } from '../../windows/MainWindow';
import { type DragProbe, loadDragProbe } from './macDragProbe';
import { DROP_SHELF_WINDOW, dropShelfPageUrl } from './page';

const POLL_MS = 90;
/** 松手到 drop 事件落进浮窗之间的余量 */
const RELEASE_GRACE_MS = 400;
const DONE_HOLD_MS = 1400;
const LEAVE_MS = 170;

let enabled = false;
let generation = 0;
let timer: ReturnType<typeof setInterval> | undefined;
let watch: DragWatchState | null = null;
let shelf: BrowserWindow | null = null;
let shelfLocale: string | null = null;
let hideTimer: ReturnType<typeof setTimeout> | undefined;
let presentToken = 0;
let pending: DropShelfDelivery[] = [];

/** 设置开关变化或启动时调用；非 macOS 恒为空操作 */
export function syncDropShelf(next: boolean): void {
  if (process.platform !== 'darwin' || next === enabled) return;
  enabled = next;
  const epoch = ++generation;
  if (!next) {
    stop();
    return;
  }
  void loadDragProbe().then((probe) => {
    if (!probe || epoch !== generation) return;
    watch = { count: probe.changeCount(), dragging: false };
    ensureShelf();
    timer = setInterval(() => tick(probe), POLL_MS);
  });
}

function stop(): void {
  clearInterval(timer);
  clearTimeout(hideTimer);
  timer = undefined;
  watch = null;
  if (shelf && !shelf.isDestroyed()) shelf.destroy();
  shelf = null;
}

function tick(probe: DragProbe): void {
  if (!watch) return;
  const { state, event } = stepDragWatch(watch, {
    count: probe.changeCount(),
    mouseDown: probe.mouseDown(),
    appActive: BrowserWindow.getFocusedWindow() !== null,
    hasFiles: () => probe.hasFiles(),
  });
  watch = state;
  if (event === 'start') void present(probe);
  else if (event === 'end') scheduleDismiss(RELEASE_GRACE_MS);
}

function shelfCopy() {
  const locale = readLocale();
  return {
    locale,
    copy: {
      title: translate(locale, 'Drop here to add to the conversation'),
      idle: translate(locale, 'Reference files in the current conversation'),
      over: translate(locale, 'Release to add'),
      attach: translate(locale, 'Add to conversation'),
      attachHint: translate(locale, 'Reference as files'),
      project: translate(locale, 'New project'),
      projectHint: translate(locale, 'Open as project'),
    },
  };
}

function ensureShelf(): BrowserWindow {
  const { locale, copy } = shelfCopy();
  const url = dropShelfPageUrl(copy, systemPreferences.getAccentColor?.().slice(0, 6) ?? '');
  if (shelf && !shelf.isDestroyed()) {
    if (locale !== shelfLocale) {
      shelfLocale = locale;
      void shelf.loadURL(url);
    }
    return shelf;
  }
  const win = new BrowserWindow({
    ...DROP_SHELF_WINDOW.single,
    type: 'panel',
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    focusable: false,
    skipTaskbar: true,
    show: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: false,
      preload: join(import.meta.dirname, '../preload/dropShelf.mjs'),
    },
  });
  win.setAlwaysOnTop(true, 'pop-up-menu');
  // skipTransformProcessType：否则 macOS 会临时改进程类型，Dock 图标闪烁
  win.setVisibleOnAllWorkspaces(true, {
    visibleOnFullScreen: true,
    skipTransformProcessType: true,
  });
  win.webContents.on('will-navigate', (event) => event.preventDefault());
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.on('closed', () => {
    if (shelf === win) shelf = null;
  });
  void win.loadURL(url);
  shelf = win;
  shelfLocale = locale;
  return win;
}

function sendState(win: BrowserWindow, state: Record<string, unknown>): void {
  const send = () => {
    if (!win.isDestroyed()) win.webContents.send(IPC_CHANNELS.DROP_SHELF_STATE, state);
  };
  if (win.webContents.isLoading()) win.webContents.once('did-finish-load', send);
  else send();
}

/** stat 失败按文件算；paths 为 null（读不到拖动内容）原样透传 */
async function directoryFlags(paths: string[] | null): Promise<boolean[] | null> {
  if (!paths) return null;
  return Promise.all(
    paths.map((path) =>
      stat(path).then(
        (info) => info.isDirectory(),
        () => false
      )
    )
  );
}

async function present(probe: DragProbe): Promise<void> {
  clearTimeout(hideTimer);
  const token = ++presentToken;
  let dragged: string[] | null = null;
  try {
    dragged = probe.filePaths(DROP_SHELF_MAX_PATHS);
  } catch (error) {
    console.warn('[drop-shelf] read dragged paths failed', error);
  }
  const layout: DropShelfLayout = dropShelfLayout(await directoryFlags(dragged));
  if (token !== presentToken || !watch?.dragging) return;
  const win = ensureShelf();
  const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  win.setBounds(dropShelfBounds(display.workArea, DROP_SHELF_WINDOW[layout], 0));
  sendState(win, { phase: 'in', layout });
  win.showInactive();
}

function scheduleDismiss(delay: number): void {
  presentToken += 1;
  clearTimeout(hideTimer);
  hideTimer = setTimeout(() => {
    const win = shelf;
    if (!win || win.isDestroyed() || !win.isVisible()) return;
    sendState(win, { phase: 'out' });
    hideTimer = setTimeout(() => {
      if (!win.isDestroyed()) win.hide();
    }, LEAVE_MS);
  }, delay);
}

function doneCopy(action: DropShelfDelivery['action'], paths: string[]) {
  const locale = readLocale();
  const name = basename(paths[0]);
  const count = String(paths.length);
  const title =
    action === 'project'
      ? paths.length === 1
        ? translate(locale, 'Opening project')
        : translate(locale, 'Opening {{count}} projects', { count })
      : paths.length === 1
        ? translate(locale, 'Added 1 file')
        : translate(locale, 'Added {{count}} files', { count });
  return {
    title,
    detail: paths.length === 1 ? name : translate(locale, '{{name}} and more', { name }),
  };
}

async function handleDrop(delivery: DropShelfDelivery | null): Promise<void> {
  if (!delivery) {
    scheduleDismiss(0);
    return;
  }
  let { paths } = delivery;
  let skipped = 0;
  // 「新建项目」只收文件夹，混进来的文件交给主窗口提示
  if (delivery.action === 'project') {
    const flags = (await directoryFlags(paths)) ?? [];
    const directories = paths.filter((_, index) => flags[index]);
    skipped = paths.length - directories.length;
    paths = directories;
  }
  if (paths.length > 0 && shelf && !shelf.isDestroyed()) {
    // 二选一面板收回单卡高度展示结果，顶边不动
    shelf.setBounds({ ...shelf.getBounds(), height: DROP_SHELF_WINDOW.single.height }, true);
    sendState(shelf, { phase: 'done', ...doneCopy(delivery.action, paths) });
    scheduleDismiss(DONE_HOLD_MS);
  } else {
    scheduleDismiss(0);
  }
  pending = [...pending, { action: delivery.action, paths, skipped }];
  if (isServerMode()) leaveServerMode();
  else focusMainWindow();
  app.focus({ steal: true });
  const main = getMainWindow();
  if (main && !main.isDestroyed()) sendToWindow(main, IPC_CHANNELS.DROP_SHELF_PENDING);
}

export function registerDropShelfHandlers(): void {
  ipcMain.on(IPC_CHANNELS.DROP_SHELF_DROP, (event, raw: unknown) => {
    if (!shelf || shelf.isDestroyed() || event.sender.id !== shelf.webContents.id) return;
    void handleDrop(parseDropShelfDrop(raw));
  });
  // 只交给本机主窗口：远程浏览器里的主界面不应收到桌面上拖来的路径
  ipcMain.handle(IPC_CHANNELS.DROP_SHELF_TAKE, (event): DropShelfDelivery[] => {
    if (localMainContents()?.id !== event.sender.id) return [];
    const taken = pending;
    pending = [];
    return taken;
  });
}
