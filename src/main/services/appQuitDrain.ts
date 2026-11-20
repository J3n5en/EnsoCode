export interface AppQuitDrainStep {
  begin?: () => void;
  shouldWait: () => boolean;
  wait: () => Promise<void>;
}

/**
 * 多个 native drain 必须共用一次 preventDefault / app.quit。
 * 各自挂 will-quit 的话，先结束的那步会在另一步还没 idle 时拆 Node 环境。
 * 收尾期间用户再次退出（Cmd+Q、关窗、菜单）不叠加：继续拦住，等这一轮收完由它放行。
 */
export function createAppQuitDrain(steps: AppQuitDrainStep[]): {
  onWillQuit: (event: { preventDefault: () => void }, quit: () => void) => void;
} {
  let phase: 'idle' | 'draining' | 'released' = 'idle';
  return {
    onWillQuit(event, quit) {
      if (phase === 'released') return;
      if (phase === 'draining') {
        event.preventDefault();
        return;
      }
      for (const step of steps) step.begin?.();
      const waiting = steps.filter((step) => step.shouldWait());
      if (waiting.length === 0) return;
      phase = 'draining';
      event.preventDefault();
      void Promise.all(waiting.map((step) => step.wait()))
        .catch(() => {})
        .finally(() => {
          phase = 'released';
          quit();
        });
    },
  };
}

export function attachAppQuitDrain(
  app: {
    on(event: 'will-quit', listener: (event: { preventDefault: () => void }) => void): void;
    quit(): void;
  },
  steps: AppQuitDrainStep[]
): void {
  const drain = createAppQuitDrain(steps);
  app.on('will-quit', (event) => drain.onWillQuit(event, () => app.quit()));
}
