import { createContext } from 'react';

/**
 * Z-Index 层级 token 体系
 * 定义应用中各类 UI 组件的堆叠顺序。
 * 取值之间留出足够间隔，便于插入子层，同时保持层级清晰。
 *
 * 详细用法见 docs/z-index-system.md。
 */
export const Z_INDEX = {
  /** 普通内容的基础层级（主窗口） */
  BASE: 0,
  /** 设置浮动窗口：紧贴主窗口之上 */
  SETTINGS_WINDOW: 10,
  /** 移动端（窄视口）侧边栏抽屉及其遮罩 */
  MOBILE_DRAWER: 30,
  /** 下拉框、菜单和弹出层 */
  DROPDOWN: 40,
  /** 模态对话框的背景遮罩 */
  MODAL_BACKDROP: 50,
  /** 模态对话框的主体内容区 */
  MODAL_CONTENT: 51,
  /** 模态框内的下拉层（必须高于模态内容） */
  DROPDOWN_IN_MODAL: 60,
  /** 嵌套（二级）模态框的背景遮罩 */
  NESTED_MODAL_BACKDROP: 70,
  /** 嵌套（二级）模态框的主体内容区 */
  NESTED_MODAL_CONTENT: 71,
  /** 嵌套模态框内的下拉层（必须高于嵌套模态内容） */
  DROPDOWN_IN_NESTED_MODAL: 80,
  /** 工具提示和悬停信息元素 */
  TOOLTIP: 100,
  /** Toast 通知和系统级提醒 */
  TOAST: 110,
  /** macOS DevTools 覆盖层：盖住原红绿灯位置 */
  DEVTOOLS_OVERLAY: 120,
} as const;

export type ZIndex = keyof typeof Z_INDEX;

/** 弹窗内容向内部下拉弹层下发的层级；弹窗外为普通下拉层级 */
export const DropdownLayer = createContext<number>(Z_INDEX.DROPDOWN);
