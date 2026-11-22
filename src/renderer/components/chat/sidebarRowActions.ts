/*
 * 侧栏行尾的悬停按钮。Tailwind v4 的 hover / group-hover 只在 (hover: hover) 设备生效，
 * 触屏（手机、PWA、远程 /desk）上按钮要靠 [@media(hover:none)] 常显；桌面类名保持原样。
 */

/** 分组行编辑按钮：桌面绝对定位盖在计数上、悬停互换；触屏回到文档流排在计数右侧，点击区 32px */
export const GROUP_EDIT_BUTTON_CLASS =
  'absolute right-1.5 bottom-0.5 flex size-5 items-center justify-center rounded-[5px] opacity-0 transition-opacity hover:bg-foreground/5 hover:text-foreground group-hover:opacity-100 [@media(hover:none)]:static [@media(hover:none)]:-my-[9px] [@media(hover:none)]:-mr-1.5 [@media(hover:none)]:ml-0.5 [@media(hover:none)]:size-[32px] [@media(hover:none)]:opacity-100';

/** 项目行的新建会话按钮：触屏常显，点击区 32px */
export const PROJECT_ROW_ACTION_CLASS =
  'shrink-0 rounded-md p-1 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 hover:bg-muted hover:text-foreground focus-visible:opacity-100 [@media(hover:none)]:flex [@media(hover:none)]:size-[32px] [@media(hover:none)]:items-center [@media(hover:none)]:justify-center [@media(hover:none)]:opacity-100';

/** 项目行的更多菜单触发器，触屏处理同上 */
export const PROJECT_ROW_MENU_CLASS =
  'shrink-0 rounded-md p-1 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 hover:bg-muted hover:text-foreground focus-visible:opacity-100 data-popup-open:bg-muted data-popup-open:text-foreground data-popup-open:opacity-100 [@media(hover:none)]:flex [@media(hover:none)]:size-[32px] [@media(hover:none)]:items-center [@media(hover:none)]:justify-center [@media(hover:none)]:opacity-100';
