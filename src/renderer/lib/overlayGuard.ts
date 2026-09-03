type Sink = (active: boolean) => void;

const defaultSink: Sink = (active) => {
  if (typeof window === 'undefined') return;
  window.electronAPI?.browser.setOverlayActive(active);
};

let sink: Sink = defaultSink;
let count = 0;
let active = false;

function sync(): void {
  const next = count > 0;
  if (next === active) return;
  active = next;
  sink(active);
}

/** 测试注入；生产用默认 IPC sink */
export function setOverlayGuardSink(next: Sink = defaultSink): void {
  sink = next;
}

export function resetOverlayGuard(): void {
  count = 0;
  active = false;
  sink = defaultSink;
}

/**
 * 模态浮层引用计数。原生 guest view 平时叠在 workbench 之上，
 * 靠 rAF 轮询矩形才沉下去 —— 弹窗打开的头一两帧会被网页挡住（闪一下）。
 * 这里在 React 提交阶段（paint 前）就通知主进程沉下去，去掉那一闪。
 */
export function acquireOverlayGuard(): void {
  count += 1;
  sync();
}

export function releaseOverlayGuard(): void {
  count = Math.max(0, count - 1);
  sync();
}

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    if (active) sink(false);
    resetOverlayGuard();
  });
}
