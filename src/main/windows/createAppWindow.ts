import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { is } from '@electron-toolkit/utils';
import { firstExistingPath } from '@shared/appServerMode';
import {
  app,
  BrowserWindow,
  Menu,
  nativeTheme,
  screen,
  type WebContents,
  WebContentsView,
} from 'electron';
import { sendToRemoteRenderers } from '../services/remoteRenderer/senders';
import { attachAppNavigationGuard, openExternalWebUrl } from './appNavigation';
import { shouldReloadRenderer } from './rendererGone';
import { attachPinnedWorkbenchBoundsSync, attachWindowsRestoreWake } from './win32Restore';
import { windowChromeOptions } from './windowChrome';
import {
  resolveWindowsAppUserModelId,
  shouldSetWindowIcon,
  windowIconCandidates,
  windowsTaskbarAppDetails,
} from './windowIcon';

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

/** destroy 窗口前先 close，避免 WebContentsView 把 renderer 进程留下来。 */
export function closeWindowWebContents(win: BrowserWindow): void {
  if (win.isDestroyed()) return;
  const workbench = workbenchViews.get(win);
  if (workbench && !workbench.webContents.isDestroyed()) workbench.webContents.close();
  if (!win.webContents.isDestroyed()) win.webContents.close();
}

export function sendToWindow(win: BrowserWindow, channel: string, ...args: unknown[]): void {
  if (win.isDestroyed()) return;
  const contents = getWindowWebContents(win);
  if (contents.isDestroyed()) return;
  contents.send(channel, ...args);
}

export function sendToAllWindows(channel: string, ...args: unknown[]): void {
  for (const win of BrowserWindow.getAllWindows()) sendToWindow(win, channel, ...args);
  sendToRemoteRenderers(channel, args);
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
    openExternalWebUrl(url);
    return { action: 'deny' };
  });
  // 页面带完整 preload：同窗跳到外站等于把 window.electronAPI 交给对方
  attachAppNavigationGuard(contents, rendererUrl(entry));

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
    if (!shouldReloadRenderer(details.reason, goneCount)) return;
    contents.reload();
  });
}

function rendererFile(entry: string): string {
  return join(import.meta.dirname, `../renderer/${entry}.html`);
}

/** 窗口实际加载的地址；导航守卫据此划定「本应用」的范围 */
function rendererUrl(entry: string): string {
  if (is.dev && process.env.ELECTRON_RENDERER_URL) {
    return `${process.env.ELECTRON_RENDERER_URL}/${entry}.html`;
  }
  return pathToFileURL(rendererFile(entry)).href;
}

function loadRenderer(contents: WebContents, entry: string): void {
  if (is.dev && process.env.ELECTRON_RENDERER_URL) {
    void contents.loadURL(rendererUrl(entry));
  } else {
    void contents.loadFile(rendererFile(entry));
  }
}

function createPinnedWorkbench(win: BrowserWindow, entry: string): WebContentsView {
  const view = new WebContentsView({ webPreferences: webPreferences() });
  view.setBackgroundColor('#00000000');
  win.contentView.addChildView(view);
  const { resync } = attachPinnedWorkbenchBoundsSync(win, view);
  if (process.platform === 'win32') {
    screen.on('display-metrics-changed', resync);
    win.on('closed', () => {
      screen.removeListener('display-metrics-changed', resync);
    });
  }
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

function resolveWindowIcon(): string | undefined {
  if (
    !shouldSetWindowIcon({
      platform: process.platform,
      isPackaged: app.isPackaged,
    })
  ) {
    return undefined;
  }
  return (
    firstExistingPath(
      windowIconCandidates({
        resourcesPath: process.resourcesPath,
        appPath: app.getAppPath(),
        cwd: process.cwd(),
      }),
      existsSync
    ) ?? undefined
  );
}

/**
 * 通用无边框窗口创建：
 * - macOS: hiddenInset 保留 traffic lights
 * - Windows: 自定义标题栏内容与原生窗口按钮共存
 * - Linux: 隐藏标题栏，渲染层自绘窗口按钮
 */
export function createAppWindow(options: CreateWindowOptions): BrowserWindow {
  const isMac = process.platform === 'darwin';
  const isWindows = process.platform === 'win32';

  const defaults: WindowState = { width: options.width, height: options.height };
  const state = options.stateFile ? loadWindowState(options.stateFile, defaults) : defaults;

  const icon = resolveWindowIcon();
  const win = new BrowserWindow({
    width: state.width,
    height: state.height,
    x: state.x,
    y: state.y,
    minWidth: options.minWidth,
    minHeight: options.minHeight,
    parent: options.parent,
    ...windowChromeOptions(
      process.platform,
      Boolean(options.pinWorkbenchView),
      isWindows && nativeTheme.shouldUseDarkColors
    ),
    ...(isMac && { trafficLightPosition: TRAFFIC_LIGHT_POSITION }),
    show: false,
    ...(icon ? { icon } : {}),
    webPreferences: webPreferences(),
  });

  if (icon) win.setIcon(icon);

  // 任务栏图标按 AUMID → 开始菜单快捷方式查找。win-unpacked 必须使用独立的 AUMID，
  // 否则 Windows 会一直沿用已安装版的方形底板图标。
  if (isWindows) {
    try {
      const appId = resolveWindowsAppUserModelId({
        execPath: process.execPath,
        isPackaged: app.isPackaged,
      });
      win.setAppDetails(
        windowsTaskbarAppDetails({
          execPath: process.execPath,
          appId,
          displayName: app.getName(),
        })
      );
    } catch (error) {
      console.warn('[window] setAppDetails failed', error);
    }
  }

  if (state.isMaximized) {
    win.maximize();
  }

  if (isWindows) {
    attachWindowsRestoreWake(win);
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
