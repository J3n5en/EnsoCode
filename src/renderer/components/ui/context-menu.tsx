'use client';

import { ContextMenu as ContextMenuPrimitive } from '@base-ui/react/context-menu';
import { ChevronRightIcon } from 'lucide-react';
import { cn } from '@/lib/utils';
import { MENU_ITEM_CLASS, MENU_POPUP_CLASS } from './menu';

/** 右键菜单:样式与 Menu 完全对齐(共用 MENU_POPUP_CLASS / MENU_ITEM_CLASS) */
const ContextMenu = ContextMenuPrimitive.Root;

function ContextMenuTrigger(props: ContextMenuPrimitive.Trigger.Props) {
  return <ContextMenuPrimitive.Trigger data-slot="context-menu-trigger" {...props} />;
}

function ContextMenuPopup({ children, className, ...props }: ContextMenuPrimitive.Popup.Props) {
  return (
    <ContextMenuPrimitive.Portal>
      <ContextMenuPrimitive.Backdrop className="fixed inset-0 z-40" data-enso-float="" />
      <ContextMenuPrimitive.Positioner className="z-50" data-slot="context-menu-positioner">
        <ContextMenuPrimitive.Popup
          className={cn(MENU_POPUP_CLASS, className)}
          data-slot="context-menu-popup"
          {...props}
        >
          <div className="max-h-(--available-height) w-full overflow-y-auto p-1.5">{children}</div>
        </ContextMenuPrimitive.Popup>
      </ContextMenuPrimitive.Positioner>
    </ContextMenuPrimitive.Portal>
  );
}

function ContextMenuItem({
  className,
  variant = 'default',
  ...props
}: ContextMenuPrimitive.Item.Props & { variant?: 'default' | 'destructive' }) {
  return (
    <ContextMenuPrimitive.Item
      className={cn(MENU_ITEM_CLASS, className)}
      data-slot="context-menu-item"
      data-variant={variant}
      {...props}
    />
  );
}

function ContextMenuSeparator(props: ContextMenuPrimitive.Separator.Props) {
  return (
    <ContextMenuPrimitive.Separator
      className="mx-2 my-1 h-px bg-border"
      data-slot="context-menu-separator"
      {...props}
    />
  );
}

/** 子菜单根：级联 Esc 只关当前层，与 Menu 钉死同一约定 */
function ContextMenuSub(props: ContextMenuPrimitive.SubmenuRoot.Props) {
  return (
    <ContextMenuPrimitive.SubmenuRoot
      data-slot="context-menu-sub"
      {...props}
      closeParentOnEsc={false}
    />
  );
}

function ContextMenuSubTrigger({
  className,
  children,
  ...props
}: ContextMenuPrimitive.SubmenuTrigger.Props) {
  return (
    <ContextMenuPrimitive.SubmenuTrigger
      className={cn(
        MENU_ITEM_CLASS,
        'data-popup-open:bg-accent data-popup-open:text-accent-foreground',
        className
      )}
      data-slot="context-menu-sub-trigger"
      {...props}
    >
      {children}
      <ChevronRightIcon className="-me-0.5 ms-auto opacity-80" />
    </ContextMenuPrimitive.SubmenuTrigger>
  );
}

/**
 * 子菜单弹层：只拼 Portal + Positioner + Popup，禁止复用 `ContextMenuPopup`。
 * 后者带全屏 Backdrop，子层再挂一张会叠出第二个 dismiss，
 * 导致 Esc 一次关多层或关完留下幽灵层。
 */
function ContextMenuSubPopup({ children, className, ...props }: ContextMenuPrimitive.Popup.Props) {
  return (
    <ContextMenuPrimitive.Portal>
      <ContextMenuPrimitive.Positioner
        align="start"
        alignOffset={-5}
        className="z-50"
        data-slot="context-menu-sub-positioner"
        side="inline-end"
        sideOffset={0}
      >
        <ContextMenuPrimitive.Popup
          className={cn(MENU_POPUP_CLASS, className)}
          data-slot="context-menu-sub-popup"
          {...props}
        >
          <div className="max-h-(--available-height) w-full overflow-y-auto p-1.5">{children}</div>
        </ContextMenuPrimitive.Popup>
      </ContextMenuPrimitive.Positioner>
    </ContextMenuPrimitive.Portal>
  );
}

export {
  ContextMenu,
  ContextMenuItem,
  ContextMenuPopup,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubPopup,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
};
