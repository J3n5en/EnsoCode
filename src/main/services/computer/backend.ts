import type { AxTreeNode } from '@shared/computer/axTree';
import type {
  ComputerAppIdentity,
  ComputerCapabilities,
  ComputerDisplayInfo,
  ComputerWindowInfo,
} from '@shared/computer/types';

export interface PointerOptions {
  button?: string;
  count?: number;
  modifiers?: string[];
  delivery?: 'background' | 'foreground';
}

/** 点击实际走的路径：可 press 的控件走 AXPress，其余为合成事件 */
export interface ClickOutcome {
  via: 'axPress' | 'synthetic' | 'hid';
}

export interface InputOutcome {
  /** 后台输入时的提醒（例如输入法可能截获了按键），原样回给模型 */
  note?: string;
}

export type TargetApp = ComputerAppIdentity & { pid: number };

export interface CaptureBytes {
  png: Buffer;
  width: number;
  height: number;
  sourceWidth: number;
  sourceHeight: number;
  originX: number;
  originY: number;
  target: string;
}

export interface DesktopBackend {
  capabilities(): Promise<ComputerCapabilities>;
  /** 一次 run 收尾（输入已投递完）：恢复 run 期间临时改动的系统状态，如输入法 */
  endRun?(): Promise<void>;
  /** 应用退出 / 宿主关闭：收尾所有合成焦点与 AX 打开声明 */
  releaseAll?(): void;
  /** 窗口或 AX ref 所属 app 的规范身份；Main 据此授权与加锁，不信任 guest 传入的路径 */
  appForTarget?(target: string): Promise<TargetApp | null>;
  appForRef?(ref: string): Promise<TargetApp | null>;
  /** desktop 级前台输入实际会落到的 app：有落点时取该点最上层窗口，否则取系统前台 */
  appForDesktopInput?(input: { point?: { x: number; y: number } }): Promise<TargetApp | null>;
  displays(): Promise<ComputerDisplayInfo[]>;
  windows(): Promise<ComputerWindowInfo[]>;
  capture(target: string, maxWidth: number, maxHeight: number): Promise<CaptureBytes>;
  click(
    target: string,
    screenX: number,
    screenY: number,
    opts?: PointerOptions
    // biome-ignore lint/suspicious/noConfusingVoidType: 不报告路径的后端（Windows、测试）直接返回 void
  ): Promise<ClickOutcome | void>;
  move(target: string, screenX: number, screenY: number, opts?: PointerOptions): Promise<void>;
  drag(
    target: string,
    points: Array<{ x: number; y: number }>,
    opts?: PointerOptions
  ): Promise<void>;
  scroll(
    target: string,
    screenX: number,
    screenY: number,
    dx: number,
    dy: number,
    opts?: PointerOptions
  ): Promise<void>;
  // biome-ignore lint/suspicious/noConfusingVoidType: 没有提醒的后端直接返回 void
  typeText(target: string, text: string, opts?: PointerOptions): Promise<InputOutcome | void>;
  // biome-ignore lint/suspicious/noConfusingVoidType: 同上
  keyChord(target: string, keys: string[], opts?: PointerOptions): Promise<InputOutcome | void>;
  raise(windowId: string): Promise<void>;
  launchApp(name: string, opts?: { pane?: string }): Promise<void>;
  axSnapshot(target: string, opts?: { maxDepth?: number; all?: boolean }): Promise<AxTreeNode[]>;
  axQuery(
    target: string,
    query: {
      role?: string;
      title?: string;
      value?: string;
      description?: string;
      limit?: number;
    }
  ): Promise<AxTreeNode[]>;
  axElementAt(screenX: number, screenY: number): Promise<AxTreeNode | null>;
  axFocused(): Promise<AxTreeNode | null>;
  axNode(ref: string): Promise<AxTreeNode>;
  axAttributes(ref: string): Promise<Array<[string, string]>>;
  axChildren(ref: string): Promise<AxTreeNode[]>;
  axParent(ref: string): Promise<AxTreeNode | null>;
  axPerform(ref: string, action: string): Promise<void>;
  axSetValue(ref: string, value: string): Promise<void>;
  axFocus(ref: string): Promise<void>;
  axClick(ref: string, opts?: PointerOptions): Promise<void>;
  clipboardRead(): Promise<string>;
  clipboardWrite(text: string): Promise<void>;
}
