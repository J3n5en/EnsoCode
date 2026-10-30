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
const PRESSABLE_ROLES = new Set([
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

/** 同一个点击意图只走一个入口：可 press 的目标控件用 AXPress，其余合成点击。 */
export function chooseClickPath(input: {
  targetPid: number;
  element: { role: string; actions?: string[]; pid?: number } | null | undefined;
  button?: string;
  count?: number;
  modifiers?: string[];
}): 'axPress' | 'synthetic' {
  if ((input.button ?? 'left').trim().toLowerCase() !== 'left') return 'synthetic';
  if ((input.count ?? 1) !== 1 || (input.modifiers?.length ?? 0) > 0) return 'synthetic';
  const element = input.element;
  if (!element || element.pid !== input.targetPid) return 'synthetic';
  if (!PRESSABLE_ROLES.has(element.role)) return 'synthetic';
  return element.actions?.includes('AXPress') ? 'axPress' : 'synthetic';
}
