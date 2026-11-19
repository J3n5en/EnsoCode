import type { RestartOverlayState, RestartWaitReason } from '@shared/types/ipc';

export type AppRestartState = 'idle' | 'restarting' | 'waiting-for-tools';

/** 主窗口弹层：点下去立刻是「正在重启」，有命令在跑改成等命令，等到了切回「正在重启」 */
export function restartOverlayFor(
  state: AppRestartState,
  waitReason?: RestartWaitReason
): RestartOverlayState | null {
  if (state === 'restarting') return { phase: 'restarting' };
  if (state === 'waiting-for-tools')
    return { phase: 'waiting', reason: waitReason ?? 'tool', exit: 'restart' };
  return null;
}

export interface AppRestartHost {
  /** 当前进程退出后再拉起一个新实例（app.relaunch） */
  relaunch(): void;
  /** 放行关窗确认：重启是用户明确点的，不再问退出还是进托盘 */
  allowQuit(): void;
  quit(): void;
  /** 退出前先等 worker 到安全点、落恢复清单；worker 报告有工具在跑时回调 onWaitingForTools */
  prepareQuit(onWaitingForTools: (reason?: RestartWaitReason) => void): Promise<unknown>;
  /** 状态变了：刷新菜单项、开关等待弹层（等待中带上在等哪种命令） */
  stateChanged(state: AppRestartState, waitReason?: RestartWaitReason): void;
  /** 用户强制退出：不再等安全点（按超时收尾，退出时尽量落断点与清单） */
  abandonPrepare(): void;
}

/**
 * 菜单「重启」：整个应用退出再打开。点击时先请 worker 到安全点（有工具在跑就等它结束，
 * 期间进入 waiting-for-tools，渲染层弹等待层），再退出；will-quit 收尾拿同一个结果，冷启动按清单续跑。
 * 等待中 forceQuit 立刻退出，不等命令。
 * 同一进程只登记一次 relaunch，多次 relaunch 会起多个实例。
 */
export function createAppRestart(host: AppRestartHost): {
  readonly state: AppRestartState;
  restart(): 'restarting' | 'already-restarting';
  forceQuit(): boolean;
} {
  let state: AppRestartState = 'idle';
  let waitReason: RestartWaitReason = 'tool';
  /** 本次重启还没退出时可调：放行并退出，只生效一次 */
  let proceed: (() => boolean) | undefined;
  const setState = (next: AppRestartState) => {
    if (state === next) return;
    state = next;
    if (next === 'waiting-for-tools') host.stateChanged(next, waitReason);
    else host.stateChanged(next);
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
      proceed = () => {
        if (quitting) return false;
        quitting = true;
        proceed = undefined;
        setState('restarting');
        host.allowQuit();
        host.quit();
        return true;
      };
      const waiting = (reason: RestartWaitReason = 'tool') => {
        if (quitting) return;
        const changed = reason !== waitReason;
        waitReason = reason;
        if (state === 'waiting-for-tools') {
          if (changed) host.stateChanged(state, reason);
        } else setState('waiting-for-tools');
      };
      let prepared: Promise<unknown>;
      try {
        prepared = host.prepareQuit(waiting);
      } catch (error) {
        prepared = Promise.reject(error);
      }
      const quit = proceed;
      void prepared
        .catch((error: unknown) => console.error('[app-restart] 等安全点失败，照常重启:', error))
        .then(quit);
      return 'restarting';
    },
    forceQuit() {
      if (!proceed) return false;
      const quit = proceed;
      try {
        host.abandonPrepare();
      } catch (error) {
        console.error('[app-restart] 强制退出时结束等待失败，照常退出:', error);
      }
      return quit();
    },
  };
}
