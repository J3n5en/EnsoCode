import type { Transition, Variants } from 'framer-motion';
import { useSyncExternalStore } from 'react';

export const instantTransition: Transition = { duration: 0 };

export const EASE_SMOOTH_OUT = [0.22, 1, 0.36, 1] as const;
export const EASE_IN_OUT = [0.4, 0, 0.2, 1] as const;
export const EASE_BOUNCE = [0.34, 1.36, 0.64, 1] as const;

export const MOTION_DURATION = {
  stagger: 0.04,
  micro: 0.08,
  quick: 0.15,
  fast: 0.25,
  medium: 0.35,
  slow: 0.4,
  verySlow: 0.5,
} as const;

/**
 * 标准弹性 —— 布局/重排动画(与 EnsoAI lib/motion.ts 的 springStandard 对齐)。
 * 体感时长约 200-300ms。
 */
export const springStandard: Transition = {
  type: 'spring',
  stiffness: 400,
  damping: 30,
};

/** 全屏铺开 —— tween 无过冲；spring 会欠阻尼回弹，带动 dock 重排显得卡 */
export const easeOutLayout: Transition = {
  type: 'tween',
  duration: 0.22,
  ease: EASE_SMOOTH_OUT,
};

export const tweenQuick: Transition = {
  type: 'tween',
  duration: MOTION_DURATION.quick,
  ease: EASE_SMOOTH_OUT,
};

export const tweenFast: Transition = {
  type: 'tween',
  duration: MOTION_DURATION.fast,
  ease: EASE_SMOOTH_OUT,
};

export const tweenPanelOpen: Transition = {
  type: 'tween',
  duration: 0.28,
  ease: EASE_SMOOTH_OUT,
};

export const tweenPanelClose: Transition = {
  type: 'tween',
  duration: 0.2,
  ease: EASE_SMOOTH_OUT,
};

/** Badge / notification dot transitions (shared with ModeSwitch, etc.) */
export const badgeSlideTransition: Transition = { duration: 0.26, ease: EASE_SMOOTH_OUT };
export const badgePopTransition: Transition = { duration: 0.45, ease: EASE_BOUNCE };
export const badgeCloseTransition: Transition = { duration: 0.16, ease: EASE_IN_OUT };

/**
 * 高度展开/收起 —— 用于分组折叠、列表展开。
 * height 不 clamp：欠阻尼 spring 冲到负值会被浏览器丢弃，停在末段再瞬间卸载，故固定用无过冲 tween。
 */
export const heightVariants: Variants = {
  initial: { height: 0, opacity: 0 },
  animate: { height: 'auto', opacity: 1, transition: easeOutLayout },
  exit: { height: 0, opacity: 0, transition: easeOutLayout },
};

/** Floating pill (Scroll-to-bottom, transient bars): asymmetric enter/exit, GPU-only */
export const floatingPillVariants: Variants = {
  initial: { opacity: 0, y: 8, scale: 0.97 },
  animate: { opacity: 1, y: 0, scale: 1, transition: { duration: 0.18, ease: EASE_SMOOTH_OUT } },
  exit: { opacity: 0, y: 4, scale: 0.98, transition: { duration: 0.12, ease: EASE_SMOOTH_OUT } },
};

/** Modal/overlay entrance variants for non-Base-UI overlays (e.g. Onboarding) */
export const modalFadeScaleVariants: Variants = {
  initial: { opacity: 0, scale: 0.96 },
  animate: { opacity: 1, scale: 1, transition: tweenFast },
  exit: { opacity: 0, scale: 0.96, transition: tweenQuick },
};

/** Directional step slide (Onboarding / multi-step wizards) */
export const stepSlideVariants: Variants = {
  enter: (direction: number) => ({ opacity: 0, x: direction * 12 }),
  center: { opacity: 1, x: 0, transition: { duration: 0.22, ease: EASE_SMOOTH_OUT } },
  exit: (direction: number) => ({
    opacity: 0,
    x: direction * -12,
    transition: { duration: 0.15, ease: EASE_SMOOTH_OUT },
  }),
};

/**
 * heightVariants 的降级版 —— prefers-reduced-motion 下使用：
 * 三个状态的视觉值一致，出现/消失即瞬时（AnimatePresence 收 exit 时无值可插值，立即卸载）。
 * framer-motion 的 reducedMotion="user" 只跳 transform/布局动画，width/height 不归它管，故显式降级。
 */
export const heightVariantsReduced: Variants = {
  initial: { opacity: 1 },
  animate: { opacity: 1 },
  exit: { opacity: 1 },
};

/**
 * 侧栏宽度动画：拖拽进行中瞬时跟手（否则 tween 追着手抖），
 * 折叠/展开或双击复位走无过冲缓动。reduced-motion 下瞬时。
 */
export function sidebarWidthTransition(input: {
  resizing?: boolean;
  collapsed?: boolean;
  reducedMotion?: boolean;
}): Transition {
  if (input.resizing || input.reducedMotion) return instantTransition;
  return easeOutLayout;
}

const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)';

/**
 * 订阅 prefers-reduced-motion：framer-motion 的 useReducedMotion 只在模块加载时
 * 读一次且之后不更新（降级语义不可靠、测试也无法注入），这里直接订阅 media query。
 */
export function usePrefersReducedMotion(): boolean {
  return useSyncExternalStore(
    (notify) => {
      if (typeof window.matchMedia !== 'function') return () => {};
      const mql = window.matchMedia(REDUCED_MOTION_QUERY);
      mql.addEventListener('change', notify);
      return () => mql.removeEventListener('change', notify);
    },
    () =>
      typeof window.matchMedia === 'function'
        ? window.matchMedia(REDUCED_MOTION_QUERY).matches
        : false,
    () => false
  );
}
