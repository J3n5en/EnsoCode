export type AppRestartState = 'idle' | 'restarting' | 'waiting-for-tools';

export interface AppRestartHost {
  /** 当前进程退出后再拉起一个新实例（app.relaunch） */
  relaunch(): void;
  /** 放行关窗确认：重启是用户明确点的，不再问退出还是进托盘 */
  allowQuit(): void;
  quit(): void;
  /** 退出前先等 worker 到安全点、落恢复清单；worker 报告有工具在跑时回调 onWaitingForTools */
  prepareQuit(onWaitingForTools: () => void): Promise<unknown>;
  /** 状态变了：刷新菜单项 */
  stateChanged(state: AppRestartState): void;
  /** 有命令在跑：告诉用户会等它结束再重启 */
  notifyWaitingForTools(): void;
}

/**
 * 菜单「重启」：整个应用退出再打开。点击时先请 worker 到安全点（有工具在跑就等它结束，
 * 并提示用户），再退出；will-quit 收尾拿同一个结果，冷启动按清单续跑。
 * 同一进程只登记一次 relaunch，多次 relaunch 会起多个实例。
 */
export function createAppRestart(host: AppRestartHost): {
  readonly state: AppRestartState;
  restart(): 'restarting' | 'already-restarting';
} {
  let state: AppRestartState = 'idle';
  const setState = (next: AppRestartState) => {
    if (state === next) return;
    state = next;
    host.stateChanged(next);
  };
  return {
    get state() {
      return state;
    },
    restart() {
      if (state !== 'idle') return 'already-restarting';
      host.relaunch();
      setState('restarting');
      let quitting = false;
      const waiting = () => {
        if (quitting || state !== 'restarting') return;
        setState('waiting-for-tools');
        host.notifyWaitingForTools();
      };
      let prepared: Promise<unknown>;
      try {
        prepared = host.prepareQuit(waiting);
      } catch (error) {
        prepared = Promise.reject(error);
      }
      void prepared
        .catch((error: unknown) => console.error('[app-restart] 等安全点失败，照常重启:', error))
        .then(() => {
          quitting = true;
          setState('restarting');
          host.allowQuit();
          host.quit();
        });
      return 'restarting';
    },
  };
}
