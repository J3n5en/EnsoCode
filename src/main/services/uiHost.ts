import type { RendererContents } from '@platform';

export interface ChromiumRendererInfo {
  mainPids: ReadonlySet<number>;
  settingsPids: ReadonlySet<number>;
  browserPids: ReadonlySet<number>;
  titles: ReadonlyMap<number, string>;
}

/** 本地界面（桌面窗口）。服务器没有本地界面，保持未安装。 */
export interface LocalUi {
  mainContents(): RendererContents | null;
  settingsContents(): RendererContents | null;
  allContents(): RendererContents[];
  /** 能力网关用的宿主 webContents id（不含远程 renderer） */
  windowContentIds(): number[];
  onWindowClosed(listener: (webContentsId: number) => void): void;
  anyFocused(): boolean;
  /** 距系统最近一次键盘或鼠标输入的毫秒数 */
  inputIdleMs(): number;
  focusMain(): void;
  chromiumRenderers(): ChromiumRendererInfo;
  /** 桌面托盘/服务器态：没有可见主窗口，pair 职责可能落到宿主 */
  trayMode(): boolean;
}

let local: LocalUi | null = null;

export function installLocalUi(ui: LocalUi): void {
  local = ui;
}

export function localUi(): LocalUi | null {
  return local;
}
