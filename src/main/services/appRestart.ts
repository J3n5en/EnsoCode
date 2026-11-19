export interface AppRestartHost {
  /** 当前进程退出后再拉起一个新实例（app.relaunch） */
  relaunch(): void;
  /** 放行关窗确认：重启是用户明确点的，不再问退出还是进托盘 */
  allowQuit(): void;
  quit(): void;
}

/**
 * 菜单「重启」：整个应用退出再打开。退出走 will-quit 收尾（等 worker 安全点、落恢复清单，
 * 10s 超时照常退出），冷启动按清单续跑。同一进程只登记一次 relaunch，多次 relaunch 会起多个实例。
 */
export function createAppRestart(host: AppRestartHost): {
  readonly restarting: boolean;
  restart(): 'restarting' | 'already-restarting';
} {
  let restarting = false;
  return {
    get restarting() {
      return restarting;
    },
    restart() {
      if (restarting) return 'already-restarting';
      host.relaunch();
      restarting = true;
      host.allowQuit();
      host.quit();
      return 'restarting';
    },
  };
}
