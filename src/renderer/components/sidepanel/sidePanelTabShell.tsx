import type { ComponentPropsWithRef, ReactNode } from 'react';
import { cn } from '@/lib/utils';

/**
 * 侧栏面板 tab 的布局壳：零占位契约的唯一定义处。
 *
 * - 非 hover 时 tab 宽度 = 图标 + 标题 + （pinned 时）常显 pin 指示器的固有宽度，
 *   没有任何为 hover 按钮预留的 padding（× 只在 hover/focus-visible 浮出）；
 * - pinned 的静态 pin 指示器留在 flex 流里（shrink-0 贴右缘），不 absolute；
 * - pin/unpin 与 × 的 hover overlay 脱离布局流 absolute 贴右缘，浮出时并排
 *   盖住指示器位置与标题尾部，渐变蒙版始终渲染以保证浮出可读；
 * - ref/className/...rest 必须透传到根 div：`<ContextMenuTrigger render={...} />`
 *   靠它注入 onContextMenu、ref 与 data-slot，少转发任何一个右键菜单就会失效。
 */
export function SidePanelTabShell({
  panelId,
  active,
  pinned,
  icon,
  title,
  pinIndicator,
  pinHoverButton,
  closeButton,
  tabRef,
  ref,
  className,
  ...rest
}: Omit<ComponentPropsWithRef<'div'>, 'title'> & {
  panelId: string;
  active: boolean;
  pinned: boolean;
  icon: ReactNode;
  title: ReactNode;
  /** pinned 时 inline 渲染在 flex 流里的非交互常显 pin 视觉指示器（可省略） */
  pinIndicator?: ReactNode;
  /** hover/focus-visible 时在 overlay 里与 × 并排浮出的 pin/unpin 按钮 */
  pinHoverButton?: ReactNode;
  closeButton: ReactNode;
  tabRef?: (node: HTMLDivElement | null) => void;
}) {
  return (
    <div
      ref={(node) => {
        tabRef?.(node);
        if (typeof ref === 'function') ref(node);
        else if (ref) ref.current = node;
      }}
      data-side-tab
      data-panel-id={panelId}
      data-active={active || undefined}
      data-pinned={pinned || undefined}
      className={cn(
        'group/tab relative flex min-w-0 items-center gap-1.5 rounded-md px-2 py-1 text-xs transition-colors',
        active ? 'bg-muted font-medium' : 'text-muted-foreground hover:bg-muted/50',
        className
      )}
      {...rest}
    >
      {icon}
      {title}
      {pinIndicator}
      {/* pin/unpin 与 × 移出布局流：零占位，悬停或键盘聚焦时在右侧渐变蒙版上
         并排浮出，盖住指示器位置与标题尾部 */}
      <div className="pointer-events-none absolute inset-y-0 right-0 flex items-center gap-0.5 rounded-r-md pl-5 pr-1">
        <div
          aria-hidden
          className="absolute inset-0 rounded-r-md bg-linear-to-l from-muted/95 from-65% to-transparent opacity-0 transition-opacity duration-100 group-hover/tab:opacity-100 group-has-[:focus-visible]/tab:opacity-100"
        />
        {pinHoverButton}
        {closeButton}
      </div>
    </div>
  );
}
