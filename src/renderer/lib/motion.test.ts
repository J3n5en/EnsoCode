import { describe, expect, it } from 'vitest';
import {
  badgeCloseTransition,
  badgePopTransition,
  badgeSlideTransition,
  EASE_BOUNCE,
  EASE_IN_OUT,
  EASE_SMOOTH_OUT,
  easeOutLayout,
  floatingPillVariants,
  heightVariants,
  heightVariantsReduced,
  instantTransition,
  MOTION_DURATION,
  modalFadeScaleVariants,
  sidebarWidthTransition,
  springStandard,
  stepSlideVariants,
  tweenFast,
  tweenPanelClose,
  tweenPanelOpen,
  tweenQuick,
} from './motion';

describe('motion tokens and presets', () => {
  it('preserves springStandard and aligns easeOutLayout to EASE_SMOOTH_OUT', () => {
    expect(springStandard).toEqual({
      type: 'spring',
      stiffness: 400,
      damping: 30,
    });
    expect(EASE_SMOOTH_OUT).toEqual([0.22, 1, 0.36, 1]);
    expect(EASE_IN_OUT).toEqual([0.4, 0, 0.2, 1]);
    expect(EASE_BOUNCE).toEqual([0.34, 1.36, 0.64, 1]);
    expect(easeOutLayout).toEqual({
      type: 'tween',
      duration: 0.22,
      ease: EASE_SMOOTH_OUT,
    });
  });

  it('keeps heightVariants on non-spring tween to prevent negative-height overshoot', () => {
    expect(heightVariants.initial).toEqual({ height: 0, opacity: 0 });
    expect(heightVariants.animate).toEqual({
      height: 'auto',
      opacity: 1,
      transition: easeOutLayout,
    });
    expect(heightVariants.exit).toEqual({
      height: 0,
      opacity: 0,
      transition: easeOutLayout,
    });
  });

  it('sidebarWidthTransition is instant while dragging and smooth tween otherwise', () => {
    expect(sidebarWidthTransition({ resizing: true, collapsed: false })).toEqual({ duration: 0 });
    expect(sidebarWidthTransition({ resizing: true, collapsed: true })).toBe(instantTransition);
    expect(sidebarWidthTransition({ resizing: false, collapsed: true })).toBe(easeOutLayout);
    expect(sidebarWidthTransition({ resizing: false, collapsed: false })).toBe(easeOutLayout);
  });

  it('enforces open/close asymmetry on tweens and variants', () => {
    expect(MOTION_DURATION.quick).toBeLessThan(MOTION_DURATION.fast);
    expect((tweenQuick as { duration: number }).duration).toBe(MOTION_DURATION.quick);
    expect((tweenFast as { duration: number }).duration).toBe(MOTION_DURATION.fast);
    expect((tweenPanelClose as { duration: number }).duration).toBeLessThan(
      (tweenPanelOpen as { duration: number }).duration
    );
    expect((badgeCloseTransition as { duration: number }).duration).toBeLessThan(
      (badgeSlideTransition as { duration: number }).duration
    );
    expect((badgePopTransition as { ease: unknown }).ease).toBe(EASE_BOUNCE);

    const pillAnimate = floatingPillVariants.animate as { transition: { duration: number } };
    const pillExit = floatingPillVariants.exit as { transition: { duration: number } };
    expect(pillExit.transition.duration).toBeLessThan(pillAnimate.transition.duration);

    const modalAnimate = modalFadeScaleVariants.animate as { transition: { duration: number } };
    const modalExit = modalFadeScaleVariants.exit as { transition: { duration: number } };
    expect(modalExit.transition.duration).toBeLessThan(modalAnimate.transition.duration);

    const stepCenter = stepSlideVariants.center as { transition: { duration: number } };
    const stepExit = (
      stepSlideVariants.exit as (dir: number) => { transition: { duration: number } }
    )(1);
    expect(stepExit.transition.duration).toBeLessThan(stepCenter.transition.duration);
  });
});

describe('sidebarWidthTransition (workbench resizing/reduced-motion)', () => {
  it('拖拽进行中瞬时跟手，宽度不经过缓动追赶', () => {
    expect(sidebarWidthTransition({ resizing: true })).toEqual({ duration: 0 });
  });

  it('prefers-reduced-motion 下瞬时不做宽度动画', () => {
    expect(sidebarWidthTransition({ reducedMotion: true })).toEqual({ duration: 0 });
  });
});

describe('heightVariantsReduced', () => {
  it('三个状态视觉值一致，出现/消失无高度插值', () => {
    const read = (v: unknown) => (typeof v === 'object' && v !== null ? v : {});
    for (const key of ['initial', 'animate', 'exit'] as const) {
      const state = read(heightVariantsReduced[key]) as Record<string, unknown>;
      expect(state.height).toBeUndefined();
      expect(state.opacity).toBe(1);
    }
  });

  it('常规版本保留高度展开动画', () => {
    expect(heightVariants.initial).toMatchObject({ height: 0, opacity: 0 });
    expect(heightVariants.exit).toMatchObject({ height: 0 });
  });
});
