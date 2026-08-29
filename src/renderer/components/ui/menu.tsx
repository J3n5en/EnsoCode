'use client';

import { Menu as MenuPrimitive } from '@base-ui/react/menu';
import { ChevronRightIcon } from 'lucide-react';
import type * as React from 'react';
import { cn } from '@/lib/utils';

/**
 * 扩展 CSSProperties 以支持 Electron 特有的 WebkitAppRegion 属性
 * 用于无边框窗口中控制拖拽区域
 */
interface ElectronCSSProperties extends React.CSSProperties {
  WebkitAppRegion?: 'drag' | 'no-drag';
}

const Menu = MenuPrimitive.Root;

const MenuPortal = MenuPrimitive.Portal;

export const MENU_POPUP_CLASS =
  // 优化动画：150ms，使用模拟 Spring 的 cubic-bezier 曲线
  "relative flex not-[class*='w-']:min-w-32 origin-(--transform-origin) rounded-lg border bg-popover bg-clip-padding shadow-lg outline-none transition-[scale,opacity] duration-150 [transition-timing-function:cubic-bezier(0.34,1.56,0.64,1)] before:pointer-events-none before:absolute before:inset-0 before:rounded-[calc(var(--radius-lg)-1px)] before:shadow-[0_1px_--theme(--color-black/4%)] focus:outline-none has-data-starting-style:scale-95 has-data-starting-style:opacity-0 has-data-ending-style:scale-95 has-data-ending-style:opacity-0 dark:bg-clip-border dark:before:shadow-[0_-1px_--theme(--color-white/8%)]";

function MenuTrigger(props: MenuPrimitive.Trigger.Props) {
  return <MenuPrimitive.Trigger data-slot="menu-trigger" {...props} />;
}

function MenuPopup({
  children,
  className,
  sideOffset = 4,
  align = 'center',
  alignOffset,
  side = 'bottom',
  ...props
}: MenuPrimitive.Popup.Props & {
  align?: MenuPrimitive.Positioner.Props['align'];
  sideOffset?: MenuPrimitive.Positioner.Props['sideOffset'];
  alignOffset?: MenuPrimitive.Positioner.Props['alignOffset'];
  side?: MenuPrimitive.Positioner.Props['side'];
}) {
  return (
    <MenuPrimitive.Portal>
      <MenuPrimitive.Backdrop className="fixed inset-0 z-40" />
      <MenuPrimitive.Positioner
        align={align}
        alignOffset={alignOffset}
        className="z-50"
        data-slot="menu-positioner"
        side={side}
        sideOffset={sideOffset}
      >
        <MenuPrimitive.Popup
          className={cn(MENU_POPUP_CLASS, className)}
          data-slot="menu-popup"
          {...props}
        >
          <div className="max-h-(--available-height) w-full overflow-y-auto p-1">{children}</div>
        </MenuPrimitive.Popup>
      </MenuPrimitive.Positioner>
    </MenuPrimitive.Portal>
  );
}

/** MenuItem 与 ContextMenuItem 共用的条目样式（含 destructive 变体） */
export const MENU_ITEM_CLASS =
  "[&_svg]:-mx-0.5 flex min-h-8 cursor-default select-none items-center gap-2 whitespace-nowrap rounded-sm px-2 py-1 text-base outline-none data-disabled:pointer-events-none data-highlighted:bg-accent data-inset:ps-8 data-[variant=destructive]:text-destructive data-highlighted:text-accent-foreground data-highlighted:data-[variant=destructive]:bg-destructive/10 data-highlighted:data-[variant=destructive]:text-destructive data-disabled:opacity-64 sm:min-h-7 sm:text-sm [&_svg:not([class*='opacity-'])]:opacity-80 [&_svg:not([class*='size-'])]:size-4.5 sm:[&_svg:not([class*='size-'])]:size-4 [&_svg]:pointer-events-none [&_svg]:shrink-0";

function MenuGroup(props: MenuPrimitive.Group.Props) {
  return <MenuPrimitive.Group data-slot="menu-group" {...props} />;
}

function MenuItem({
  className,
  inset,
  variant = 'default',
  style,
  ...props
}: MenuPrimitive.Item.Props & {
  inset?: boolean;
  variant?: 'default' | 'destructive';
}) {
  return (
    <MenuPrimitive.Item
      className={cn(MENU_ITEM_CLASS, className)}
      data-inset={inset}
      data-slot="menu-item"
      data-variant={variant}
      style={{ WebkitAppRegion: 'no-drag', ...style } as ElectronCSSProperties}
      {...props}
    />
  );
}

function MenuCheckboxItem({
  className,
  children,
  checked,
  ...props
}: MenuPrimitive.CheckboxItem.Props) {
  return (
    <MenuPrimitive.CheckboxItem
      checked={checked}
      className={cn(
        "grid min-h-8 in-data-[side=none]:min-w-[calc(var(--anchor-width)+1.25rem)] cursor-default grid-cols-[1rem_1fr] items-center gap-2 rounded-sm py-1 ps-2 pe-4 text-base outline-none data-disabled:pointer-events-none data-highlighted:bg-accent data-highlighted:text-accent-foreground data-disabled:opacity-64 sm:min-h-7 sm:text-sm [&_svg:not([class*='size-'])]:size-4.5 sm:[&_svg:not([class*='size-'])]:size-4 [&_svg]:pointer-events-none [&_svg]:shrink-0",
        className
      )}
      data-slot="menu-checkbox-item"
      {...props}
    >
      <MenuPrimitive.CheckboxItemIndicator className="col-start-1">
        <svg
          aria-hidden="true"
          fill="none"
          height="24"
          stroke="currentColor"
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth="2"
          viewBox="0 0 24 24"
          width="24"
          xmlns="http://www.w3.org/2000/svg"
        >
          <path d="M5.252 12.7 10.2 18.63 18.748 5.37" />
        </svg>
      </MenuPrimitive.CheckboxItemIndicator>
      <span className="col-start-2">{children}</span>
    </MenuPrimitive.CheckboxItem>
  );
}

function MenuRadioGroup(props: MenuPrimitive.RadioGroup.Props) {
  return <MenuPrimitive.RadioGroup data-slot="menu-radio-group" {...props} />;
}

function MenuRadioItem({ className, children, ...props }: MenuPrimitive.RadioItem.Props) {
  return (
    <MenuPrimitive.RadioItem
      className={cn(
        "grid min-h-8 in-data-[side=none]:min-w-[calc(var(--anchor-width)+1.25rem)] cursor-default grid-cols-[1rem_1fr] items-center gap-2 rounded-sm py-1 ps-2 pe-4 text-base outline-none data-disabled:pointer-events-none data-highlighted:bg-accent data-highlighted:text-accent-foreground data-disabled:opacity-64 sm:min-h-7 sm:text-sm [&_svg:not([class*='size-'])]:size-4.5 sm:[&_svg:not([class*='size-'])]:size-4 [&_svg]:pointer-events-none [&_svg]:shrink-0",
        className
      )}
      data-slot="menu-radio-item"
      {...props}
    >
      <MenuPrimitive.RadioItemIndicator className="col-start-1">
        <svg
          aria-hidden="true"
          fill="none"
          height="24"
          stroke="currentColor"
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth="2"
          viewBox="0 0 24 24"
          width="24"
          xmlns="http://www.w3.org/2000/svg"
        >
          <path d="M5.252 12.7 10.2 18.63 18.748 5.37" />
        </svg>
      </MenuPrimitive.RadioItemIndicator>
      <span className="col-start-2">{children}</span>
    </MenuPrimitive.RadioItem>
  );
}

function MenuGroupLabel({
  className,
  inset,
  ...props
}: MenuPrimitive.GroupLabel.Props & {
  inset?: boolean;
}) {
  return (
    <MenuPrimitive.GroupLabel
      className={cn(
        'px-2 py-1.5 font-medium text-muted-foreground text-xs data-inset:ps-9 sm:data-inset:ps-8',
        className
      )}
      data-inset={inset}
      data-slot="menu-label"
      {...props}
    />
  );
}

function MenuSeparator({ className, ...props }: MenuPrimitive.Separator.Props) {
  return (
    <MenuPrimitive.Separator
      className={cn('mx-2 my-1 h-px bg-border', className)}
      data-slot="menu-separator"
      {...props}
    />
  );
}

function MenuShortcut({ className, ...props }: React.ComponentProps<'span'>) {
  return (
    <span
      className={cn(
        'ms-auto font-medium text-muted-foreground/72 text-xs tracking-widest',
        className
      )}
      data-slot="menu-shortcut"
      {...props}
    />
  );
}

function MenuSub(props: MenuPrimitive.SubmenuRoot.Props) {
  return (
    <MenuPrimitive.SubmenuRoot
      data-slot="menu-sub"
      {...props}
      // 级联 Esc 必须只关当前子层。默认已是 false，这里钉死，避免调用方误开 closeParentOnEsc。
      closeParentOnEsc={false}
    />
  );
}

function MenuSubTrigger({
  className,
  inset,
  children,
  ...props
}: MenuPrimitive.SubmenuTrigger.Props & {
  inset?: boolean;
}) {
  return (
    <MenuPrimitive.SubmenuTrigger
      className={cn(
        "flex min-h-8 items-center gap-2 rounded-sm px-2 py-1 text-base outline-none data-disabled:pointer-events-none data-highlighted:bg-accent data-popup-open:bg-accent data-inset:ps-8 data-highlighted:text-accent-foreground data-popup-open:text-accent-foreground data-disabled:opacity-64 sm:min-h-7 sm:text-sm [&_svg:not([class*='size-'])]:size-4.5 sm:[&_svg:not([class*='size-'])]:size-4 [&_svg]:pointer-events-none",
        className
      )}
      data-inset={inset}
      data-slot="menu-sub-trigger"
      {...props}
    >
      {children}
      <ChevronRightIcon className="-me-0.5 ms-auto opacity-80" />
    </MenuPrimitive.SubmenuTrigger>
  );
}

/**
 * 子菜单弹层：必须自己拼 Portal + Positioner + Popup，禁止复用 `MenuPopup`。
 * `MenuPopup` 是根菜单专用（Portal + Backdrop + Positioner + Popup）。子层再包一层
 * 会再挂一张全屏 Backdrop / 再叠一个 dismiss，Esc 一次关多层或关完留下幽灵层。
 * 仍走同一套 base-ui Menu.Portal，不另起门户。
 */
function MenuSubPopup({
  children,
  className,
  sideOffset = 0,
  alignOffset,
  align = 'start',
  ...props
}: MenuPrimitive.Popup.Props & {
  align?: MenuPrimitive.Positioner.Props['align'];
  sideOffset?: MenuPrimitive.Positioner.Props['sideOffset'];
  alignOffset?: MenuPrimitive.Positioner.Props['alignOffset'];
}) {
  const defaultAlignOffset = align !== 'center' ? -5 : undefined;

  return (
    <MenuPrimitive.Portal>
      <MenuPrimitive.Positioner
        align={align}
        alignOffset={alignOffset ?? defaultAlignOffset}
        className="z-50"
        data-slot="menu-sub-positioner"
        side="inline-end"
        sideOffset={sideOffset}
      >
        <MenuPrimitive.Popup
          className={cn(MENU_POPUP_CLASS, className)}
          data-slot="menu-sub-content"
          {...props}
        >
          <div className="max-h-(--available-height) w-full overflow-y-auto p-1">{children}</div>
        </MenuPrimitive.Popup>
      </MenuPrimitive.Positioner>
    </MenuPrimitive.Portal>
  );
}

/**
 * TitleBarMenuPopup - 专门用于标题栏的菜单弹出层
 * 使用透明 Backdrop 支持点击关闭，同时保持 no-drag
 */
function TitleBarMenuPopup({
  children,
  className,
  sideOffset = 4,
  align = 'start',
  alignOffset = -4,
  side = 'bottom',
  ...props
}: MenuPrimitive.Popup.Props & {
  align?: MenuPrimitive.Positioner.Props['align'];
  sideOffset?: MenuPrimitive.Positioner.Props['sideOffset'];
  alignOffset?: MenuPrimitive.Positioner.Props['alignOffset'];
  side?: MenuPrimitive.Positioner.Props['side'];
}) {
  return (
    <MenuPrimitive.Portal>
      {/* 透明 Backdrop，支持点击关闭，设置 no-drag 避免拖拽冲突 */}
      <MenuPrimitive.Backdrop
        className="fixed inset-0 z-[99]"
        style={{ WebkitAppRegion: 'no-drag' } as ElectronCSSProperties}
      />
      <MenuPrimitive.Positioner
        align={align}
        alignOffset={alignOffset}
        className="z-[100]"
        data-slot="menu-positioner"
        side={side}
        sideOffset={sideOffset}
        style={{ WebkitAppRegion: 'no-drag' } as ElectronCSSProperties}
      >
        <MenuPrimitive.Popup
          className={cn(
            // 基础样式
            "relative flex not-[class*='w-']:min-w-32 rounded-md border bg-popover shadow-lg outline-none",
            // 优化动画：150ms，使用模拟 Spring 的 cubic-bezier 曲线
            'origin-(--transform-origin) transition-[scale,opacity] duration-150 [transition-timing-function:cubic-bezier(0.34,1.56,0.64,1)]',
            'has-data-starting-style:scale-95 has-data-starting-style:opacity-0',
            'has-data-ending-style:scale-95 has-data-ending-style:opacity-0',
            // 标题栏菜单使用更小的字体
            '[&_[data-slot=menu-item]]:text-xs [&_[data-slot=menu-item]]:min-h-7 [&_[data-slot=menu-item]]:py-1.5',
            '[&_[data-slot=menu-shortcut]]:text-[10px]',
            className
          )}
          data-slot="menu-popup"
          style={{ WebkitAppRegion: 'no-drag' } as ElectronCSSProperties}
          {...props}
        >
          <div
            className="max-h-(--available-height) w-full overflow-y-auto p-1"
            style={{ WebkitAppRegion: 'no-drag' } as ElectronCSSProperties}
          >
            {children}
          </div>
        </MenuPrimitive.Popup>
      </MenuPrimitive.Positioner>
    </MenuPrimitive.Portal>
  );
}

export {
  Menu,
  Menu as DropdownMenu,
  MenuCheckboxItem,
  MenuCheckboxItem as DropdownMenuCheckboxItem,
  MenuGroup,
  MenuGroup as DropdownMenuGroup,
  MenuGroupLabel,
  MenuGroupLabel as DropdownMenuLabel,
  MenuItem,
  MenuItem as DropdownMenuItem,
  MenuPopup,
  MenuPopup as DropdownMenuContent,
  MenuPortal,
  MenuPortal as DropdownMenuPortal,
  MenuRadioGroup,
  MenuRadioGroup as DropdownMenuRadioGroup,
  MenuRadioItem,
  MenuRadioItem as DropdownMenuRadioItem,
  MenuSeparator,
  MenuSeparator as DropdownMenuSeparator,
  MenuShortcut,
  MenuShortcut as DropdownMenuShortcut,
  MenuSub,
  MenuSub as DropdownMenuSub,
  MenuSubPopup,
  MenuSubPopup as DropdownMenuSubContent,
  MenuSubTrigger,
  MenuSubTrigger as DropdownMenuSubTrigger,
  MenuTrigger,
  MenuTrigger as DropdownMenuTrigger,
  TitleBarMenuPopup,
};
