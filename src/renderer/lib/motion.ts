import type { Transition } from 'framer-motion';

/**
 * 标准弹性 —— 布局/重排动画(与 EnsoAI lib/motion.ts 的 springStandard 对齐)。
 * 体感时长约 200-300ms。
 */
export const springStandard: Transition = {
  type: 'spring',
  stiffness: 400,
  damping: 30,
};
