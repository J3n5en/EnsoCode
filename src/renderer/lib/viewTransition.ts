/** 工作区 ↔ 设置页切换（PLAN §3.6）：侧栏横滑 + 主区交叉淡入，WAAPI 原地反向 */
export const VIEW_TRANSITION = {
  duration: 180,
  /** --ease-smooth-out */
  easing: 'cubic-bezier(0.22, 1, 0.36, 1)',
  shift: 10,
  /** 退场主区保持不透明到这一点，任何时刻都有一层不透明面板，画布不会透出来 */
  underlayHold: 0.6,
} as const;

export type ViewSide = 'workbench' | 'settings';

export interface ViewLayers {
  sidebar: Element | null;
  main: Element | null;
}

export interface ViewTransitionResult {
  animating: boolean;
  /** 叠在上面的一侧：开始时的进场方，半途反向也不换 */
  top: ViewSide;
}

interface Active {
  to: ViewSide;
  top: ViewSide;
  animations: Animation[];
}

export function createViewTransition(options: {
  reducedMotion: () => boolean;
  onSettle: () => void;
}) {
  let active: Active | null = null;
  /** 已结束、还靠 fill 停在终态的动画：等调用方把新状态提交进 DOM 后再撤销 */
  let settled: Animation[] = [];

  const release = () => {
    for (const animation of settled) animation.cancel();
    settled = [];
  };

  const settle = () => {
    if (!active) return;
    settled.push(...active.animations);
    active = null;
    options.onSettle();
  };

  const run = (to: ViewSide, layers: Record<ViewSide, ViewLayers>): ViewTransitionResult => {
    if (options.reducedMotion()) {
      settle();
      release();
      return { animating: false, top: to };
    }
    if (active) {
      if (active.to !== to) {
        active.to = to;
        for (const animation of active.animations) animation.reverse();
      }
      return { animating: true, top: active.top };
    }
    release();
    const from: ViewSide = to === 'settings' ? 'workbench' : 'settings';
    const shift = VIEW_TRANSITION.shift * (to === 'settings' ? 1 : -1);
    const timing = (easing: string): KeyframeAnimationOptions => ({
      duration: VIEW_TRANSITION.duration,
      easing,
      fill: 'both',
    });
    const smooth = timing(VIEW_TRANSITION.easing);
    const x = (px: number) => `translateX(${px}px)`;
    const animations = [
      layers[from].sidebar?.animate(
        [
          { opacity: 1, transform: x(0) },
          { opacity: 0, transform: x(-shift) },
        ],
        smooth
      ),
      layers[to].sidebar?.animate(
        [
          { opacity: 0, transform: x(shift) },
          { opacity: 1, transform: x(0) },
        ],
        smooth
      ),
      layers[from].main?.animate(
        [{ opacity: 1 }, { opacity: 1, offset: VIEW_TRANSITION.underlayHold }, { opacity: 0 }],
        timing('linear')
      ),
      layers[to].main?.animate([{ opacity: 0 }, { opacity: 1 }], smooth),
    ].filter((animation): animation is Animation => animation !== undefined);
    const current: Active = { to, top: to, animations };
    active = current;
    void Promise.all(animations.map((animation) => animation.finished)).then(
      () => {
        if (active === current) settle();
      },
      () => {}
    );
    return { animating: true, top: to };
  };

  return {
    run,
    /** 进行中的目标一侧；没有动画时为 null */
    target: (): ViewSide | null => active?.to ?? null,
    /** onSettle 触发的状态提交进 DOM 之后调用（layout effect 里），与隐藏/卸载落在同一帧 */
    release,
    finish: () => {
      settle();
      release();
    },
  };
}

/** 切换那一次提交两层都要在场；退场的设置层留到动画结束，工作区动画结束才隐藏 */
export function viewLayerState(state: { open: boolean; shown: boolean; animating: boolean }): {
  settingsMounted: boolean;
  workbenchHidden: boolean;
} {
  return {
    settingsMounted: state.open || state.shown || state.animating,
    workbenchHidden: state.open && state.shown && !state.animating,
  };
}

export const prefersReducedMotion = (): boolean =>
  typeof window.matchMedia === 'function' &&
  window.matchMedia('(prefers-reduced-motion: reduce)').matches;
