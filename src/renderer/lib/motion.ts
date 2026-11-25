import type { Transition, Variants } from 'framer-motion';

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

export const instantTransition: Transition = { duration: 0 };

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

/** Left sidebar width transition: instant while dragging, smooth non-overshooting glide otherwise */
export function sidebarWidthTransition(input: {
  resizing?: boolean;
  collapsed: boolean;
}): Transition {
  if (input.resizing) return instantTransition;
  return easeOutLayout;
}

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
