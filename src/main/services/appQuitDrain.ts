export interface AppQuitDrainStep {
  begin?: () => void;
  shouldWait: () => boolean;
  wait: () => Promise<void>;
}

/**
 * 多个 native drain 必须共用一次 preventDefault / app.quit。
 * 各自挂 will-quit 的话，先结束的那步会在另一步还没 idle 时拆 Node 环境。
 */
export function createAppQuitDrain(steps: AppQuitDrainStep[]): {
  onWillQuit: (event: { preventDefault: () => void }, quit: () => void) => void;
} {
  let draining = false;
  return {
    onWillQuit(event, quit) {
      if (draining) return;
      for (const step of steps) step.begin?.();
      const waiting = steps.filter((step) => step.shouldWait());
      if (waiting.length === 0) return;
      draining = true;
      event.preventDefault();
      void Promise.all(waiting.map((step) => step.wait()))
        .catch(() => {})
        .finally(quit);
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
