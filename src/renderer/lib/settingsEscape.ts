import { overlayGuardActive } from './overlayGuard';

const EDITABLE_TARGET = 'input, textarea, select, [contenteditable=""], [contenteditable="true"]';
const OVERLAY = '[role="dialog"], [role="alertdialog"], [data-enso-float]';

/**
 * Esc 按下那一刻（任何处理者之前）是否有弹层。弹层自己会在处理中关掉，
 * 冒泡到窗口时已经看不到了，所以要在捕获阶段先记下来。藏起来的工作区里的浮层不算。
 */
export function escapeBlockedBeforeHandlers(doc: ParentNode): boolean {
  if (overlayGuardActive()) return true;
  return Array.from(doc.querySelectorAll(OVERLAY)).some(
    (el) => !el.closest('[data-enso="workbench"]')
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
