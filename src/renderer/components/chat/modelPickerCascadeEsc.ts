/**
 * ModelPicker 级联 Esc 的根层拦截契约。
 *
 * 结构前提（不要扁平化级联，也不另起 portal）：
 * 子菜单必须走 `MenuSubPopup`（Portal + Positioner + Popup），禁止复用根层 `MenuPopup`
 * （那会再叠一张 Backdrop / 再叠一层 dismiss）。
 *
 * 根层 `useDismiss` 在 hook 阶段拿不到 `FloatingTree`（Provider 包在 children 上），
 * `hasBlockingChild` 对根菜单恒为 false。焦点若还在父层（hover 开了子菜单、或误进搜索框），
 * 第一下 Esc 会把整棵关掉。焦点已在当前子层 Menu item 上时，子层自己的 dismiss 会先停掉冒泡。
 *
 * 本函数只挡 `escape-key`：
 * - 级联中且焦点不在搜索框 → cancel 根层 close，让当前子层自己关；
 * - 搜索模式 / 点击外部 → 不拦截，整棵一次关完。
 */

export const CASCADE_ESCAPE_REASON = 'escape-key';

export interface CascadeEscapeDetails {
  reason?: string;
  cancel: () => void;
  allowPropagation: () => void;
}

export interface CascadeEscapeContext {
  openSubmenuCount: number;
  searchFocused: boolean;
}

/** 根菜单这次 close 是否应拦截（只关当前级）。true = 已 cancel，调用方不要 setOpen(false)。 */
export function interceptRootCascadeEscape(
  nextOpen: boolean,
  details: CascadeEscapeDetails,
  context: CascadeEscapeContext
): boolean {
  if (nextOpen) return false;
  if (details.reason !== CASCADE_ESCAPE_REASON) return false;
  if (context.searchFocused) return false;
  if (context.openSubmenuCount <= 0) return false;
  details.cancel();
  details.allowPropagation();
  return true;
}

export function markSubmenuOpen(openIds: Set<string>, id: string, nextOpen: boolean): void {
  if (nextOpen) openIds.add(id);
  else openIds.delete(id);
}
