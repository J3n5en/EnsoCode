import type { Transition, Variants } from 'framer-motion';

/**
 * 标准弹性 —— 布局/重排动画(与 EnsoAI lib/motion.ts 的 springStandard 对齐)。
 * 体感时长约 200-300ms。
 */
export const springStandard: Transition = {
  type: 'spring',
  stiffness: 400,
  damping: 30,
};

/** 高度展开/收起 —— 用于分组折叠、列表展开(与 EnsoAI heightVariants 对齐) */
export const heightVariants: Variants = {
  initial: { height: 0, opacity: 0 },
  animate: { height: 'auto', opacity: 1 },
  exit: { height: 0, opacity: 0 },
};
