import { describe, expect, it, vi } from 'vitest';
import { createViewTransition, VIEW_TRANSITION, type ViewLayers } from './viewTransition';

interface FakeAnimation {
  keyframes: Keyframe[];
  options: KeyframeAnimationOptions;
  rate: number;
  cancelled: boolean;
  reverse(): void;
  cancel(): void;
  finish(): void;
  finished: Promise<unknown>;
}

function fakeElement(name: string, log: FakeAnimation[]) {
  return {
    name,
    animate(keyframes: Keyframe[], options: KeyframeAnimationOptions) {
      let resolve!: () => void;
      const anim: FakeAnimation = {
        keyframes,
        options,
        rate: 1,
        cancelled: false,
        finished: new Promise<void>((r) => {
          resolve = r;
        }),
        reverse() {
          anim.rate = -anim.rate;
        },
        cancel() {
          anim.cancelled = true;
        },
        finish() {
          resolve();
        },
      };
      log.push(anim);
      return anim as unknown as Animation;
    },
  } as unknown as Element;
}

function setup(reduced = false) {
  const log: FakeAnimation[] = [];
  const layers: Record<'workbench' | 'settings', ViewLayers> = {
    workbench: { sidebar: fakeElement('wb-sidebar', log), main: fakeElement('wb-main', log) },
    settings: { sidebar: fakeElement('st-nav', log), main: fakeElement('st-card', log) },
  };
  const onSettle = vi.fn();
  const reducedMotion = vi.fn(() => reduced);
  const transition = createViewTransition({ reducedMotion, onSettle });
  const flush = async () => {
    for (const anim of log) anim.finish();
    await Promise.resolve();
    await Promise.resolve();
  };
  return { log, layers, onSettle, transition, flush, reducedMotion };
}

const translate = (frames: Keyframe[]) => frames.map((f) => f.transform);

describe('设置进出过渡（§3.6）', () => {
  it('进入：侧栏 180ms smooth-out 横滑 ±10px，主区交叉淡入，旧主区前 60% 保持不透明', () => {
    const { log, layers, transition } = setup();
    expect(transition.run('settings', layers)).toEqual({ animating: true, top: 'settings' });
    expect(log).toHaveLength(4);
    for (const anim of log) expect(anim.options.duration).toBe(180);
    const [sbOut, sbIn, mainOut, mainIn] = log;
    expect(translate(sbOut.keyframes)).toEqual(['translateX(0px)', 'translateX(-10px)']);
    expect(sbOut.keyframes.map((f) => f.opacity)).toEqual([1, 0]);
    expect(translate(sbIn.keyframes)).toEqual(['translateX(10px)', 'translateX(0px)']);
    expect(sbIn.options.easing).toBe(VIEW_TRANSITION.easing);
    expect(VIEW_TRANSITION.easing).toBe('cubic-bezier(0.22, 1, 0.36, 1)');
    expect(mainOut.keyframes).toEqual([
      { opacity: 1 },
      { opacity: 1, offset: 0.6 },
      { opacity: 0 },
    ]);
    expect(mainOut.options.easing).toBe('linear');
    expect(mainIn.keyframes).toEqual([{ opacity: 0 }, { opacity: 1 }]);
  });

  it('返回：同参数反方向，会话列表从左滑入，设置导航向右滑出', () => {
    const { log, layers, transition } = setup();
    expect(transition.run('workbench', layers).top).toBe('workbench');
    const [sbOut, sbIn] = log;
    expect(translate(sbOut.keyframes)).toEqual(['translateX(0px)', 'translateX(10px)']);
    expect(translate(sbIn.keyframes)).toEqual(['translateX(-10px)', 'translateX(0px)']);
  });

  it('结束后取消动画效果并通知一次', async () => {
    const { log, layers, transition, onSettle, flush } = setup();
    transition.run('settings', layers);
    await flush();
    expect(onSettle).toHaveBeenCalledTimes(1);
    expect(log.every((a) => a.cancelled)).toBe(true);
  });

  it('半途反向：原地 reverse()，不新建动画，层级保持开始时的上下关系', async () => {
    const { log, layers, transition, onSettle, flush } = setup();
    transition.run('settings', layers);
    expect(transition.run('workbench', layers)).toEqual({ animating: true, top: 'settings' });
    expect(log).toHaveLength(4);
    expect(log.every((a) => a.rate === -1)).toBe(true);
    await flush();
    expect(onSettle).toHaveBeenCalledTimes(1);
  });

  it('连按任意次只在同一段动画上来回，最终方向是最后一次', async () => {
    const { log, layers, transition, onSettle, flush } = setup();
    const targets = ['settings', 'workbench', 'settings', 'workbench', 'settings'] as const;
    for (const to of targets) transition.run(to, layers);
    expect(log).toHaveLength(4);
    expect(log.every((a) => a.rate === 1)).toBe(true);
    expect(transition.target()).toBe('settings');
    await flush();
    expect(onSettle).toHaveBeenCalledTimes(1);
    expect(transition.target()).toBeNull();
  });

  it('同方向重复触发不重启动画', () => {
    const { log, layers, transition } = setup();
    transition.run('settings', layers);
    transition.run('settings', layers);
    expect(log).toHaveLength(4);
  });

  it('减少动态效果：不创建任何动画，直接替换', () => {
    const { log, layers, transition } = setup(true);
    expect(transition.run('settings', layers)).toEqual({ animating: false, top: 'settings' });
    expect(log).toHaveLength(0);
  });

  it('动画中途系统改成减少动态效果：结束进行中的动画并直接替换', () => {
    const { log, layers, transition, onSettle, reducedMotion } = setup();
    transition.run('settings', layers);
    reducedMotion.mockReturnValue(true);
    expect(transition.run('workbench', layers).animating).toBe(false);
    expect(log.every((a) => a.cancelled)).toBe(true);
    expect(onSettle).toHaveBeenCalledTimes(1);
  });

  it('缺层（窄屏没有侧栏）照常运行', () => {
    const { log, layers, transition } = setup();
    transition.run('settings', {
      workbench: { sidebar: null, main: layers.workbench.main },
      settings: { sidebar: layers.settings.sidebar, main: null },
    });
    expect(log).toHaveLength(2);
  });
});
