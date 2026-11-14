import type * as React from 'react';
import { cn } from '@/lib/utils';

/** 行容器：悬停或键盘聚焦到行内时整行着色，行内 HoverActions 跟着浮出 */
export const HOVER_ROW_CLASS =
  'group/row relative transition-colors hover:bg-foreground/5 has-[:focus-visible]:bg-foreground/5';

/**
 * 行内操作：平时不占位、不可见、点不到；悬停这一行或键盘聚焦到行内时，叠在行右侧的渐变蒙版上浮出。
 * 放在带 HOVER_ROW_CLASS 的行里；蒙版底色默认对上着色后的行底，不着色的行用 className 改 from-*。
 */
export function HoverActions({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="hover-actions"
      className={cn(
        'pointer-events-none absolute inset-y-0 right-0 flex items-center gap-0.5 rounded-r-[inherit] pr-1 pl-8 opacity-0 transition-opacity duration-100',
        'bg-linear-to-l from-[color-mix(in_oklab,var(--background),var(--foreground)_5%)] from-60% to-transparent',
        'group-hover/row:pointer-events-auto group-hover/row:opacity-100 group-has-[:focus-visible]/row:pointer-events-auto group-has-[:focus-visible]/row:opacity-100',
        className
      )}
      {...props}
    />
  );
}

/**
 * 给从行内打开的弹窗当 finalFocus：键盘关的照常还焦点；鼠标/触摸关的不还，
 * 否则 Chrome 会让还回去的按钮带上 :focus-visible，行内操作在鼠标移开后仍浮着。
 * 类型为空（外部改 open 关的）时看关闭那一刻是不是键盘可见焦点。
 */
export function rowFinalFocus(closeType: string): boolean {
  if (closeType) return closeType === 'keyboard';
  return Boolean(document.activeElement?.matches(':focus-visible'));
}
