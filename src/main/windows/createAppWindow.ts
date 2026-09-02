import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { is } from '@electron-toolkit/utils';
import { app, BrowserWindow, Menu, shell, type WebContents, WebContentsView } from 'electron';

export interface CreateWindowOptions {
  /** renderer 入口 html 文件名（不含扩展名），对应 electron.vite renderer input */
  entry: string;
  width: number;
  height: number;
  minWidth?: number;
  minHeight?: number;
  /** 持久化窗口位置/尺寸的状态文件名，不传则不持久化 */
  stateFile?: string;
  parent?: BrowserWindow;
  /** 主窗口：UI 走独立顶层 WebContentsView，guest 网页才能垫在下面 */
  pinWorkbenchView?: boolean;
}

interface WindowState {
  width: number;
  height: number;
  x?: number;
  y?: number;
  isMaximized?: boolean;
}

function loadWindowState(stateFile: string, defaults: WindowState): WindowState {
  try {
    const statePath = join(app.getPath('userData'), stateFile);
    if (existsSync(statePath)) {
      return { ...defaults, ...JSON.parse(readFileSync(statePath, 'utf-8')) };
    }
  } catch {}
  return defaults;
}

const workbenchViews = new WeakMap<BrowserWindow, WebContentsView>();

export function getWorkbenchView(win: BrowserWindow): WebContentsView | undefined {
  return workbenchViews.get(win);
}

/** 主窗口 UI 的 webContents（pin 后不是 win.webContents） */
export function getWindowWebContents(win: BrowserWindow): WebContents {
  return workbenchViews.get(win)?.webContents ?? win.webContents;
}

export function sendToWindow(win: BrowserWindow, channel: string, ...args: unknown[]): void {
  if (win.isDestroyed()) return;
  const contents = getWindowWebContents(win);
  if (contents.isDestroyed()) return;
  contents.send(channel, ...args);
}

export function sendToAllWindows(channel: string, ...args: unknown[]): void {
  for (const win of BrowserWindow.getAllWindows()) sendToWindow(win, channel, ...args);
}

function webPreferences(): Electron.WebPreferences {
  return {
    nodeIntegration: false,
    contextIsolation: true,
    sandbox: false,
    preload: join(import.meta.dirname, '../preload/index.mjs'),
  };
}

function attachWebContentsHandlers(win: BrowserWindow, contents: WebContents, entry: string): void {
  contents.on('context-menu', (event, params) => {
    if (params.isEditable) {
      event.preventDefault();
      Menu.buildFromTemplate([
        { role: 'cut', enabled: params.editFlags.canCut },
        { role: 'copy', enabled: params.editFlags.canCopy },
        { role: 'paste', enabled: params.editFlags.canPaste },
        { type: 'separator' },
        { role: 'selectAll', enabled: params.editFlags.canSelectAll },
      ]).popup({ window: win, x: params.x, y: params.y });
      return;
    }
    if (params.selectionText) {
      event.preventDefault();
      Menu.buildFromTemplate([{ role: 'copy', enabled: params.editFlags.canCopy }]).popup({
        window: win,
        x: params.x,
        y: params.y,
      });
    }
  });

  contents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https:') || url.startsWith('http:')) {
      shell.openExternal(url);
    }
    return { action: 'deny' };
  });

  const recoverable = new Set(['crashed', 'abnormal-exit', 'oom', 'launch-failed']);
  let goneAt = 0;
  let goneCount = 0;
  contents.on('render-process-gone', (_event, details) => {
    const now = Date.now();
    if (now - goneAt > 60_000) goneCount = 0;
    goneAt = now;
    goneCount += 1;
    console.error(
      `[renderer] render-process-gone entry=${entry} reason=${details.reason} exitCode=${details.exitCode} count=${goneCount}`
    );
    if (win.isDestroyed() || contents.isDestroyed()) return;
    if (!recoverable.has(details.reason) || goneCount > 3) return;
    contents.reload();
  });
}

function loadRenderer(contents: WebContents, entry: string): void {
  if (is.dev && process.env.ELECTRON_RENDERER_URL) {
    void contents.loadURL(`${process.env.ELECTRON_RENDERER_URL}/${entry}.html`);
  } else {
    void contents.loadFile(join(import.meta.dirname, `../renderer/${entry}.html`));
  }
}

function createPinnedWorkbench(win: BrowserWindow, entry: string): WebContentsView {
  const view = new WebContentsView({ webPreferences: webPreferences() });
  const sync = (): void => {
    if (win.isDestroyed()) return;
    const { width, height } = win.getContentBounds();
    view.setBounds({ x: 0, y: 0, width, height });
  };
  view.setBackgroundColor('#00000000');
  win.contentView.addChildView(view);
  win.on('resize', sync);
  sync();
  workbenchViews.set(win, view);
  attachWebContentsHandlers(win, view.webContents, entry);
  view.webContents.once('did-finish-load', () => {
    if (!win.isDestroyed()) win.show();
  });
  loadRenderer(view.webContents, entry);
  return view;
}

function saveWindowState(win: BrowserWindow, stateFile: string): void {
  try {
    const bounds = win.getBounds();
    const state: WindowState = { ...bounds, isMaximized: win.isMaximized() };
    writeFileSync(join(app.getPath('userData'), stateFile), JSON.stringify(state));
  } catch {}
}

/** macOS 红绿灯自定义位置（按 44px 标题栏垂直居中） */
export const TRAFFIC_LIGHT_POSITION = { x: 16, y: 16 };

/**
 * 通用无边框窗口创建：
 * - macOS: hiddenInset 保留 traffic lights
 * - Windows/Linux: hidden 隐藏标题栏，渲染层自绘标题栏
 */
export function createAppWindow(options: CreateWindowOptions): BrowserWindow {
  const isMac = process.platform === 'darwin';
  const isWindows = process.platform === 'win32';

  const defaults: WindowState = { width: options.width, height: options.height };
  const state = options.stateFile ? loadWindowState(options.stateFile, defaults) : defaults;

  const win = new BrowserWindow({
    width: state.width,
    height: state.height,
    x: state.x,
    y: state.y,
    minWidth: options.minWidth,
    minHeight: options.minHeight,
    parent: options.parent,
    titleBarStyle: isMac ? 'hiddenInset' : 'hidden',
    frame: isMac,
    ...(isMac && { trafficLightPosition: TRAFFIC_LIGHT_POSITION }),
    ...(isWindows && { thickFrame: true }),
    show: false,
    backgroundColor: '#00000000',
    ...(options.pinWorkbenchView ? { transparent: true } : {}),
    webPreferences: webPreferences(),
  });

  if (state.isMaximized) {
    win.maximize();
  }

  if (options.stateFile) {
    win.on('close', () => saveWindowState(win, options.stateFile as string));
  }

  if (options.pinWorkbenchView) {
    createPinnedWorkbench(win, options.entry);
  } else {
    win.once('ready-to-show', () => {
      win.show();
    });
    attachWebContentsHandlers(win, win.webContents, options.entry);
    loadRenderer(win.webContents, options.entry);
  }

  return win;
}
