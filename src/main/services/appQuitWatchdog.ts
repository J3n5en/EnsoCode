import type { AppExitReason } from '@shared/types/ipc';
import { QUIT_TOOL_WAIT_LIMIT_MS } from './agentQuitLimits';

/** 整个退出的上限：工具等待上限之外再留 30 秒写清单、停 worker、关窗 */
export const QUIT_WATCHDOG_LIMIT_MS = QUIT_TOOL_WAIT_LIMIT_MS + 30_000;
/** 开始关窗后不再有合法的长等待（安全点已过），收尾最多这么久 */
export const QUIT_FINISH_LIMIT_MS = 30_000;
/** app.exit 之后还没退出就 SIGKILL 自己（relaunch 由独立的 relauncher 进程执行，不受影响） */
export const QUIT_EXIT_GRACE_MS = 5_000;

export interface QuitWatchdogHost {
  relaunch(): void;
  exit(): void;
  kill(): void;
  log(message: string): void;
  /** 进入退出流程时调一次 */
  began?(): void;
}

interface QuitRun {
  reason: AppExitReason;
  startedAt: number;
  deadline: number;
  step: string;
  /** 已经登记过 relaunch（菜单重启），强退时不再登记第二次，免得起两个实例 */
  relaunched: boolean;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * 退出 / 重启 / 安装更新的总看门狗：超时还没退出就强制 app.exit（重启与更新先 relaunch），
 * 日志写明卡在哪一步。同一次退出多个入口叠加时沿用最早的期限，只升级原因（退出 → 重启）。
 */
export function createQuitWatchdog(
  host: QuitWatchdogHost,
  limits = {
    totalMs: QUIT_WATCHDOG_LIMIT_MS,
    finishMs: QUIT_FINISH_LIMIT_MS,
    exitGraceMs: QUIT_EXIT_GRACE_MS,
  }
) {
  let run: QuitRun | null = null;
  let fired = false;

  const arm = (current: QuitRun) => {
    clearTimeout(current.timer);
    current.timer = setTimeout(fire, Math.max(0, current.deadline - Date.now()));
  };

  const fire = () => {
    const current = run;
    if (!current || fired) return;
    fired = true;
    const reopen = current.reason !== 'quit';
    host.log(
      `[quit-watchdog] ${current.reason}: 退出 ${Date.now() - current.startedAt}ms 还没完成，卡在「${current.step}」，强制退出${reopen ? '并重新打开' : ''}`
    );
    if (reopen && !current.relaunched) {
      try {
        host.relaunch();
      } catch (error) {
        host.log(`[quit-watchdog] relaunch 失败: ${String(error)}`);
      }
    }
    setTimeout(() => host.kill(), limits.exitGraceMs);
    try {
      host.exit();
    } catch (error) {
      host.log(`[quit-watchdog] app.exit 失败，直接结束进程: ${String(error)}`);
      host.kill();
    }
  };

  return {
    /** 进入退出流程（用户已确认 / 点了重启 / 开始安装更新） */
    begin(reason: AppExitReason, step: string, options: { relaunched?: boolean } = {}): void {
      if (fired) return;
      if (run) {
        if (reason !== 'quit') run.reason = reason;
        run.relaunched ||= options.relaunched === true;
        run.step = step;
        return;
      }
      const now = Date.now();
      run = {
        reason,
        startedAt: now,
        deadline: now + limits.totalMs,
        step,
        relaunched: options.relaunched === true,
        timer: undefined as unknown as ReturnType<typeof setTimeout>,
      };
      arm(run);
      try {
        host.began?.();
      } catch {
        /* 不能挡住退出 */
      }
    },
    /** 记下当前步骤；finishing：安全点已过、开始关窗收尾，期限收紧到 finishMs 内。没在退出时按退出开始 */
    step(step: string, options: { finishing?: boolean } = {}): void {
      if (fired) return;
      if (!run) this.begin('quit', step);
      const current = run as QuitRun;
      current.step = step;
      if (!options.finishing) return;
      const deadline = Math.min(current.deadline, Date.now() + limits.finishMs);
      if (deadline === current.deadline) return;
      current.deadline = deadline;
      arm(current);
    },
    /** 退出没有发生（安装更新失败已恢复窗口） */
    cancel(): void {
      if (!run || fired) return;
      clearTimeout(run.timer);
      run = null;
    },
    active(): boolean {
      return run !== null;
    },
  };
}

let host: Partial<QuitWatchdogHost> = {};

/** Electron 入口注入 relaunch / exit 与落盘日志（主进程没有日志文件，结论写进 worker-exits.log） */
export function configureQuitWatchdog(next: Omit<QuitWatchdogHost, 'kill'>): void {
  host = next;
}

function logQuit(message: string): void {
  console.error(message);
  try {
    host.log?.(message);
  } catch {
    /* 落盘失败不能挡住强退 */
  }
}

let quietErrors = false;

export const quitWatchdog = createQuitWatchdog({
  relaunch: () => host.relaunch?.(),
  exit: () => host.exit?.(),
  kill: () => process.kill(process.pid, 'SIGKILL'),
  // 主进程没有 uncaughtException 处理时 Electron 弹模态错误框、阻塞主线程：
  // 窗口已关时用户看不到它，看门狗的定时器也跑不了。进入退出流程后只记日志
  began: () => {
    if (quietErrors) return;
    quietErrors = true;
    process.on('uncaughtException', (error) =>
      logQuit(`[quit-watchdog] 退出中未捕获的异常: ${error?.stack ?? String(error)}`)
    );
  },
  log: logQuit,
});

/** 已进入退出流程：拦 close 的浮窗此时必须放行，否则安装更新（先关窗再 before-quit）永远关不完窗 */
export function isAppQuitting(): boolean {
  return quitWatchdog.active();
}
