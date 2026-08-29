'use client';

import { ContextMenu as ContextMenuPrimitive } from '@base-ui/react/context-menu';
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
      <ContextMenuPrimitive.Backdrop className="fixed inset-0 z-40" />
      <ContextMenuPrimitive.Positioner className="z-50" data-slot="context-menu-positioner">
        <ContextMenuPrimitive.Popup
          className={cn(MENU_POPUP_CLASS, className)}
          data-slot="context-menu-popup"
          {...props}
        >
          <div className="max-h-(--available-height) w-full overflow-y-auto p-1">{children}</div>
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
      className="-mx-1 my-1 h-px bg-border"
      data-slot="context-menu-separator"
      {...props}
    />
  );
}

export { ContextMenu, ContextMenuItem, ContextMenuPopup, ContextMenuSeparator, ContextMenuTrigger };
