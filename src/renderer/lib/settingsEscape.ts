import { overlayGuardActive } from './overlayGuard';

const EDITABLE_TARGET = 'input, textarea, select, [contenteditable=""], [contenteditable="true"]';
const OVERLAY = '[role="dialog"], [role="alertdialog"], [data-enso-float]';

/**
 * Esc 按下那一刻（任何处理者之前）是否有弹层。弹层自己会在处理中关掉，
 * 冒泡到窗口时已经看不到了，所以要在捕获阶段先记下来。藏起来的工作区里的浮层不算。
 */
/**
 * 这个弹层此刻会不会吃掉 Esc：
 * - base-ui 的 open 翻成 false 后它的 Esc 处理立刻短路，但节点要等 transitionend 才卸载
 *   （data-closed / data-ending-style），后台窗口动画不结束就一直挂着，不能让它吞 Esc；
 * - toast 这类 aria-modal=false 的 role=dialog 从不响应 Esc。
 */
function consumesEscape(el: Element): boolean {
  if (el.hasAttribute('data-closed') || el.hasAttribute('data-ending-style')) return false;
  if (el.getAttribute('aria-modal') === 'false') return false;
  return true;
}

export function escapeBlockedBeforeHandlers(doc: ParentNode): boolean {
  if (overlayGuardActive()) return true;
  return Array.from(doc.querySelectorAll(OVERLAY)).some(
    (el) => !el.closest('[data-enso="workbench"]') && consumesEscape(el)
  );
}

export function shouldEscapeCloseSettings(
  event: {
    key: string;
    defaultPrevented: boolean;
    isComposing: boolean;
    target: EventTarget | null;
  },
  blockedBeforeHandlers: boolean
): boolean {
  if (event.key !== 'Escape' || event.defaultPrevented || event.isComposing) return false;
  if (blockedBeforeHandlers) return false;
  const target = event.target as Element | null;
  return !target?.closest?.(EDITABLE_TARGET);
}
