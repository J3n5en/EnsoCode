/**
 * 侧栏手动排序（项目拖拽 / 置顶拖拽）的 localStorage 读写与变更订阅。
 * 只是展示层偏好，不进 settings store；pairCatalog 订阅它把顺序下发手机。
 */

export const PROJECT_ORDER_KEY = 'enso-project-order';
export const PINNED_ORDER_KEY = 'enso-pinned-order';

type OrderKey = typeof PROJECT_ORDER_KEY | typeof PINNED_ORDER_KEY;

const listeners = new Set<() => void>();

export function readSidebarOrder(key: OrderKey): string[] {
  try {
    const saved = JSON.parse(localStorage.getItem(key) ?? '[]');
    return Array.isArray(saved) ? saved : [];
  } catch {
    return [];
  }
}

export function writeSidebarOrder(key: OrderKey, ids: readonly string[]): void {
  localStorage.setItem(key, JSON.stringify(ids));
  for (const listener of listeners) listener();
}

/** 拖拽落盘后通知订阅方（同窗口 storage 事件不触发，须显式广播） */
export function subscribeSidebarOrder(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
