import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { is } from '@electron-toolkit/utils';
import { app, BrowserWindow, Menu, shell } from 'electron';

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
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: false,
      preload: join(import.meta.dirname, '../preload/index.mjs'),
    },
  });

  if (state.isMaximized) {
    win.maximize();
  }

  win.once('ready-to-show', () => {
    win.show();
  });

  if (options.stateFile) {
    win.on('close', () => saveWindowState(win, options.stateFile as string));
  }

  // 可编辑区域启用原生右键菜单（剪切/复制/粘贴/全选）；非编辑区选中文本时提供复制
  win.webContents.on('context-menu', (event, params) => {
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
    // 对话区域等只读内容：有选中文本时给复制
    if (params.selectionText) {
      event.preventDefault();
      Menu.buildFromTemplate([{ role: 'copy', enabled: params.editFlags.canCopy }]).popup({
        window: win,
        x: params.x,
        y: params.y,
      });
    }
  });

  // 外链跳转系统浏览器
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https:') || url.startsWith('http:')) {
      shell.openExternal(url);
    }
    return { action: 'deny' };
  });

  // Chromium CHECK（SIGTRAP）主进程收不到 JS 异常，只能靠 gone。
  // 自动 reload 避免白屏；短时反复崩则停，免得死循环。
  const recoverable = new Set(['crashed', 'abnormal-exit', 'oom', 'launch-failed']);
  let goneAt = 0;
  let goneCount = 0;
  win.webContents.on('render-process-gone', (_event, details) => {
    const now = Date.now();
    if (now - goneAt > 60_000) goneCount = 0;
    goneAt = now;
    goneCount += 1;
    console.error(
      `[renderer] render-process-gone entry=${options.entry} reason=${details.reason} exitCode=${details.exitCode} count=${goneCount}`
    );
    if (win.isDestroyed() || win.webContents.isDestroyed()) return;
    if (!recoverable.has(details.reason) || goneCount > 3) return;
    win.webContents.reload();
  });

  if (is.dev && process.env.ELECTRON_RENDERER_URL) {
    win.loadURL(`${process.env.ELECTRON_RENDERER_URL}/${options.entry}.html`);
  } else {
    win.loadFile(join(import.meta.dirname, `../renderer/${options.entry}.html`));
  }

  return win;
}
