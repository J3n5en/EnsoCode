import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

/**
 * 侧栏面板 tab 的布局壳：零占位契约的唯一定义处。
 *
 * - 非 hover 时 tab 宽度 = 图标 + 标题 + （pinned 时）常显 pin 的固有宽度，
 *   没有任何为 hover 按钮预留的 padding（× 只在 hover/focus-visible 浮出）；
 * - pinned 的 pin 留在 flex 流里（shrink-0 贴右缘），不 absolute；
 * - ×/pin 的 hover overlay 脱离布局流 absolute 贴右缘，浮出时盖住 pin 位置
 *   与标题尾部，渐变蒙版始终渲染以保证浮出可读。
 */
export function SidePanelTabShell({
  panelId,
  active,
  pinned,
  icon,
  title,
  pinButton,
  pinHoverButton,
  closeButton,
  tabRef,
}: {
  panelId: string;
  active: boolean;
  pinned: boolean;
  icon: ReactNode;
  title: ReactNode;
  /** pinned 时 inline 渲染在 flex 流里的常显 pin（可省略） */
  pinButton?: ReactNode;
  /** 非 pinned 时 hover 浮出的 pin（放进 overlay） */
  pinHoverButton?: ReactNode;
  closeButton: ReactNode;
  tabRef?: (node: HTMLDivElement | null) => void;
}) {
  return (
    <div
      ref={tabRef}
      data-side-tab
      data-panel-id={panelId}
      data-active={active || undefined}
      data-pinned={pinned || undefined}
      className={cn(
        'group/tab relative flex min-w-0 items-center gap-1.5 rounded-md px-2 py-1 text-xs transition-colors',
        active ? 'bg-muted font-medium' : 'text-muted-foreground hover:bg-muted/50'
      )}
    >
      {icon}
      {title}
      {pinButton}
      {/* ×/pin 移出布局流：零占位，悬停或键盘聚焦时在右侧渐变蒙版上浮出，
         盖住 pin 位置与标题尾部 */}
      <div className="pointer-events-none absolute inset-y-0 right-0 flex items-center gap-0.5 rounded-r-md pl-5 pr-1">
        <div
          aria-hidden
          className="absolute inset-0 rounded-r-md bg-linear-to-l from-muted/90 from-55% to-transparent opacity-0 transition-opacity duration-100 group-hover/tab:opacity-100 group-has-[:focus-visible]/tab:opacity-100"
        />
        {pinHoverButton}
        {closeButton}
      </div>
    </div>
  );
}
