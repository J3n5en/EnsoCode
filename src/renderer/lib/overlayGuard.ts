type Sink = (active: boolean) => void;

const defaultSink: Sink = (active) => {
  if (typeof window === 'undefined') return;
  // PWA 的 electronAPI 是降级 shim，没有 browser 桥；缺链即静默跳过。
  window.electronAPI?.browser?.setOverlayActive(active);
};

let sink: Sink = defaultSink;
let overlayCount = 0;
let coverCount = 0;
let active = false;

function sync(): void {
  const next = overlayCount + coverCount > 0;
  if (next === active) return;
  active = next;
  sink(active);
}

/** 测试注入；生产用默认 IPC sink */
export function setOverlayGuardSink(next: Sink = defaultSink): void {
  sink = next;
}

/**
 * 全量重推当前值（不看边沿）。主进程持有的是上一代 renderer 的值，
 * 新 renderer 从 active=false 起步永远不会补发 false，不重推就会永久闩死。
 */
export function syncOverlayGuard(): void {
  sink(active);
}

export function resetOverlayGuard(): void {
  overlayCount = 0;
  coverCount = 0;
  active = false;
  sink = defaultSink;
}

/**
 * 模态浮层引用计数。原生 guest view 平时叠在 workbench 之上，
 * 靠 rAF 轮询矩形才沉下去 —— 弹窗打开的头一两帧会被网页挡住（闪一下）。
 * 这里在 React 提交阶段（paint 前）就通知主进程沉下去，去掉那一闪。
 */
export function acquireOverlayGuard(): void {
  overlayCount += 1;
  sync();
}

export function releaseOverlayGuard(): void {
  overlayCount = Math.max(0, overlayCount - 1);
  sync();
}

/**
 * 工作区遮盖引用计数（设置页这类盖住整个 workbench 的页面）。
 * 同样要让原生 guest 沉下去，但它不是会吃 Esc 的模态浮层，
 * 所以单独计数，不计入 overlayGuardActive()。
 */
export function acquireWorkbenchCover(): void {
  coverCount += 1;
  sync();
}

export function releaseWorkbenchCover(): void {
  coverCount = Math.max(0, coverCount - 1);
  sync();
}

/** 此刻是否有真模态浮层（会先于设置页吃掉 Esc 的那类）。工作区遮盖不算。 */
export function overlayGuardActive(): boolean {
  return overlayCount > 0;
}

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    if (active) sink(false);
    resetOverlayGuard();
  });
}
