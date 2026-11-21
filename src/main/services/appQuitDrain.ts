export interface AppQuitDrainStep {
  /** 看门狗日志里写明卡在哪一步 */
  name?: string;
  begin?: () => void;
  shouldWait: () => boolean;
  wait: () => Promise<void>;
}

/**
 * 多个 native drain 必须共用一次 preventDefault / app.quit。
 * 各自挂 will-quit 的话，先结束的那步会在另一步还没 idle 时拆 Node 环境。
 * 收尾期间用户再次退出（Cmd+Q、关窗、菜单）不叠加：继续拦住，等这一轮收完由它放行。
 * 任何一步同步抛错或 reject 都照常放行；onProgress 报告还在等的步骤（开始时与每步结束时）。
 */
export function createAppQuitDrain(
  steps: AppQuitDrainStep[],
  onProgress: (pending: string[]) => void = () => {}
): {
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
      for (const step of steps) {
        try {
          step.begin?.();
        } catch (error) {
          console.error(`[app-quit] ${step.name ?? '收尾'} 开始失败，照常退出:`, error);
        }
      }
      const waiting = steps.filter((step) => {
        try {
          return step.shouldWait();
        } catch {
          return false;
        }
      });
      const names = waiting.map((step, index) => step.name ?? `step${index + 1}`);
      const remaining = new Set(names.keys());
      const report = () => {
        try {
          onProgress([...remaining].map((index) => names[index]));
        } catch {
          /* 进度上报不能挡住退出 */
        }
      };
      report();
      if (waiting.length === 0) return;
      phase = 'draining';
      event.preventDefault();
      void Promise.allSettled(
        waiting.map((step, index) => {
          let waited: Promise<void>;
          try {
            waited = Promise.resolve(step.wait());
          } catch (error) {
            waited = Promise.reject(error);
          }
          return waited.finally(() => {
            remaining.delete(index);
            report();
          });
        })
      ).then(() => {
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
  steps: AppQuitDrainStep[],
  onProgress?: (pending: string[]) => void
): void {
  const drain = createAppQuitDrain(steps, onProgress);
  app.on('will-quit', (event) => drain.onWillQuit(event, () => app.quit()));
}
