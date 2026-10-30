export type SkyClickEventKind = 'moved' | 'down' | 'up' | 'dragged';
export type SkyClickPointKind = 'target' | 'primer';
export type SkyMouseButton = 'left' | 'right' | 'middle';

export type SkyClickEventStep = {
  kind: SkyClickEventKind;
  pointKind: SkyClickPointKind;
  clickState: number;
  phase: number;
  delayAfterMs: number;
  /** 拖拽路径里的点序号；点击只有一个目标点，省略即 0 */
  pointIndex?: number;
};

const CG_BUTTON_EVENT_TYPE: Record<SkyMouseButton, { down: number; up: number; dragged: number }> =
  {
    left: { down: 1, up: 2, dragged: 6 },
    right: { down: 3, up: 4, dragged: 7 },
    middle: { down: 25, up: 26, dragged: 27 },
  };
const CG_MOUSE_MOVED = 5;
export const CG_SCROLL_WHEEL = 22;

export function skyClickCgEventType(
  kind: SkyClickEventKind,
  button: SkyMouseButton = 'left'
): number {
  if (kind === 'moved') return CG_MOUSE_MOVED;
  return CG_BUTTON_EVENT_TYPE[button][kind];
}

export function skyMouseButton(button: string | undefined): SkyMouseButton {
  const value = (button ?? 'left').trim().toLowerCase();
  if (value === 'left' || value === 'right' || value === 'middle') return value;
  throw new Error(`unsupported mouse button: ${button}`);
}

export function skyMouseButtonNumber(button: SkyMouseButton): number {
  return button === 'left' ? 0 : button === 'right' ? 1 : 2;
}

const MOVE_STEP: SkyClickEventStep = {
  kind: 'moved',
  pointKind: 'target',
  clickState: 0,
  phase: 2,
  delayAfterMs: 15,
};
/** (-1,-1) 处的左键 down/up：让后台窗口接受随后的 click-through，不落在任何控件上 */
const PRIMER_STEPS: SkyClickEventStep[] = [
  { kind: 'down', pointKind: 'primer', clickState: 1, phase: 1, delayAfterMs: 1 },
  { kind: 'up', pointKind: 'primer', clickState: 1, phase: 2, delayAfterMs: 100 },
];

export function skyClickEventRecipe(clickCount: number): SkyClickEventStep[] {
  if (clickCount !== 1 && clickCount !== 2) {
    throw new Error('sky_click supports click_count 1 or 2');
  }
  return skyPointerClickRecipe({ button: 'left', count: clickCount });
}

/** 任意按钮、1–3 击。只有左键需要 primer；右键/中键加 primer 会在目标里多出一次左键。 */
export function skyPointerClickRecipe(input: {
  button: SkyMouseButton;
  count: number;
}): SkyClickEventStep[] {
  const clickCount = input.count;
  if (!Number.isInteger(clickCount) || clickCount < 1 || clickCount > 3) {
    throw new Error(`unsupported click count: ${clickCount}`);
  }
  const steps: SkyClickEventStep[] = [{ ...MOVE_STEP }];
  if (input.button === 'left') steps.push(...PRIMER_STEPS.map((step) => ({ ...step })));
  for (let pair = 1; pair <= clickCount; pair += 1) {
    steps.push({
      kind: 'down',
      pointKind: 'target',
      clickState: pair,
      phase: 3,
      delayAfterMs: 1,
    });
    steps.push({
      kind: 'up',
      pointKind: 'target',
      clickState: pair,
      phase: 3,
      delayAfterMs: pair < clickCount ? 80 : 0,
    });
  }
  return steps;
}

/** 线段按 maxStep 插值：应用只在 dragged 事件之间做命中/跟随，跳太远会丢掉拖拽目标。 */
export function skyDragPath(
  points: Array<{ x: number; y: number }>,
  maxStep = 12
): Array<{ x: number; y: number }> {
  if (points.length === 0) return [];
  const out = [{ ...points[0] }];
  for (let i = 1; i < points.length; i++) {
    const from = points[i - 1];
    const to = points[i];
    const distance = Math.hypot(to.x - from.x, to.y - from.y);
    const segments = Math.max(1, Math.ceil(distance / Math.max(1, maxStep)));
    for (let s = 1; s <= segments; s++) {
      out.push({
        x: from.x + ((to.x - from.x) * s) / segments,
        y: from.y + ((to.y - from.y) * s) / segments,
      });
    }
  }
  return out;
}

/** 左键拖拽：移到起点 → primer → 起点按下 → 逐点 dragged → 终点抬起。 */
export function skyDragRecipe(pointCount: number): SkyClickEventStep[] {
  if (!Number.isInteger(pointCount) || pointCount < 2) {
    throw new Error('drag needs at least two points');
  }
  const steps: SkyClickEventStep[] = [
    { ...MOVE_STEP, pointIndex: 0 },
    ...PRIMER_STEPS.map((step) => ({ ...step })),
    {
      kind: 'down',
      pointKind: 'target',
      clickState: 1,
      phase: 3,
      delayAfterMs: 30,
      pointIndex: 0,
    },
  ];
  for (let i = 1; i < pointCount; i++) {
    steps.push({
      kind: 'dragged',
      pointKind: 'target',
      clickState: 1,
      phase: 3,
      delayAfterMs: 12,
      pointIndex: i,
    });
  }
  steps.push({
    kind: 'up',
    pointKind: 'target',
    clickState: 1,
    phase: 3,
    delayAfterMs: 0,
    pointIndex: pointCount - 1,
  });
  return steps;
}

export function skyLightActivationRecord(windowId: number, focused: boolean): Uint8Array {
  const record = new Uint8Array(0xf8);
  record[0x04] = 0xf8;
  record[0x08] = 0x0d;
  record[0x3c] = windowId & 0xff;
  record[0x3d] = (windowId >> 8) & 0xff;
  record[0x3e] = (windowId >> 16) & 0xff;
  record[0x3f] = (windowId >> 24) & 0xff;
  record[0x8a] = focused ? 0x01 : 0x02;
  return record;
}

/**
 * 让目标 app 把该窗口设为 key/main 而不提升层级（类型 0x01、0x02 两条，顺序固定）。
 * 只发激活包时，AppKit 会把键盘交给它原来的 key 窗口，同 app 多窗口时会打进别的文档。
 */
export function skyLightKeyWindowRecords(windowId: number): [Uint8Array, Uint8Array] {
  const make = (type: number) => {
    const record = new Uint8Array(0xf8);
    record[0x04] = 0xf8;
    record[0x08] = type;
    record[0x3a] = 0x10;
    record.fill(0xff, 0x20, 0x30);
    record[0x3c] = windowId & 0xff;
    record[0x3d] = (windowId >> 8) & 0xff;
    record[0x3e] = (windowId >> 16) & 0xff;
    record[0x3f] = (windowId >> 24) & 0xff;
    return record;
  };
  return [make(0x01), make(0x02)];
}

export function skyClickLocalPoint(
  screen: { x: number; y: number },
  bounds: { x: number; y: number; width: number; height: number }
): { x: number; y: number } {
  return { x: screen.x - bounds.x, y: screen.y - bounds.y };
}

export function skyClickWindowMatchesTarget(
  windows: Array<{ id: string; pid?: number; onScreen?: boolean }>,
  windowId: number,
  pid: number
): boolean {
  return windows.some(
    (window) => Number(window.id) === windowId && window.pid === pid && window.onScreen !== false
  );
}

export const SKY_CLICK_UNAVAILABLE = 'SKY_CLICK_UNAVAILABLE';

export function isSkyClickUnavailable(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message === SKY_CLICK_UNAVAILABLE || message.startsWith(`${SKY_CLICK_UNAVAILABLE}:`);
}
