export type ClickRoute = 'skyClick' | 'postToPid' | 'hid' | 'unavailable';

/** 前台意味着真实指针（HID）；后台按可得的身份选窗口事件或进程事件，缺身份就不可用。 */
export function resolveClickRoute(input: {
  delivery?: 'background' | 'foreground';
  pid?: number;
  windowId?: number;
}): ClickRoute {
  if ((input.delivery ?? 'background') === 'foreground') return 'hid';
  const hasPid = typeof input.pid === 'number' && input.pid > 0;
  if (!hasPid) return 'unavailable';
  return typeof input.windowId === 'number' && input.windowId > 0 ? 'skyClick' : 'postToPid';
}

/** 有 press 语义、且 press 等价于左键单击的控件；文本框、表格行等需要落点的控件不在内。 */
export const PRESSABLE_ROLES = new Set([
  'AXButton',
  'AXCheckBox',
  'AXRadioButton',
  'AXMenuItem',
  'AXMenuBarItem',
  'AXMenuButton',
  'AXPopUpButton',
  'AXLink',
  'AXDisclosureTriangle',
  'AXTab',
]);

/** 命中到控件里的文字/图标时，向上找它所属的可按控件（最多几层） */
export const PRESS_LABEL_ROLES = new Set(['AXStaticText', 'AXImage', 'AXGroup']);
export const PRESS_ANCESTOR_DEPTH = 3;

/** 同一个点击意图只走一个入口：可 press 的目标控件用 AXPress，其余合成点击。 */
export function chooseClickPath(input: {
  targetPid: number;
  /** 给出时要求元素就在该窗口里：同 app 的其它窗口可能盖在落点上 */
  targetWindowId?: number;
  element: { role: string; actions?: string[]; pid?: number; windowId?: number } | null | undefined;
  button?: string;
  count?: number;
  modifiers?: string[];
}): 'axPress' | 'synthetic' {
  if ((input.button ?? 'left').trim().toLowerCase() !== 'left') return 'synthetic';
  if ((input.count ?? 1) !== 1 || (input.modifiers?.length ?? 0) > 0) return 'synthetic';
  const element = input.element;
  if (!element || element.pid !== input.targetPid) return 'synthetic';
  if (input.targetWindowId !== undefined && element.windowId !== input.targetWindowId) {
    return 'synthetic';
  }
  if (!PRESSABLE_ROLES.has(element.role)) return 'synthetic';
  return element.actions?.includes('AXPress') ? 'axPress' : 'synthetic';
}

/**
 * AX 元素退回坐标点击时选窗口：元素自带的窗口号优先，其次同进程里包含控件中心的最前窗口，
 * 再退到 ref 登记的窗口；desktop 作用域的 ref 才退到同进程第一个窗口。
 */
export function pickWindowForElement(
  windows: Array<{ id: string; pid?: number; x: number; y: number; width: number; height: number }>,
  input: { pid?: number; windowId?: number; center: { x: number; y: number }; fallback: string }
): string {
  if (input.windowId !== undefined) {
    const byId = windows.find((window) => Number(window.id) === input.windowId);
    if (byId) return byId.id;
  }
  const own = input.pid === undefined ? [] : windows.filter((window) => window.pid === input.pid);
  const { x, y } = input.center;
  const containing = own.find(
    (window) =>
      x >= window.x && y >= window.y && x < window.x + window.width && y < window.y + window.height
  );
  if (containing) return containing.id;
  if (input.fallback !== 'desktop') return input.fallback;
  return own[0]?.id ?? input.fallback;
}
