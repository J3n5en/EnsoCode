import {
  type ExitKind,
  type ExitWindow,
  inExitWindow,
  isExitCausedStreamError,
} from '@shared/exitInterrupt';

/** 本次启动认定的「上次退出」事实：窗口内到达的断流错误归到这里 */
export interface ExitInterruption {
  /** 上次退出时刻 */
  at: number;
  kind: ExitKind;
  window: ExitWindow;
}

let current: ExitInterruption | null = null;

export function setExitInterruption(value: ExitInterruption | null): void {
  current = value;
}

export function currentExitInterruption(): ExitInterruption | null {
  return current;
}

/**
 * 模型层报的断流/断连，且时间点落在退出窗口内：这是应用退出导致的，不是会话失败。
 * 窗口外的同类错误仍按真实失败处理。
 */
export function exitInterruptionOf(error: string | undefined, at: number): ExitInterruption | null {
  if (!current) return null;
  if (!isExitCausedStreamError(error)) return null;
  return inExitWindow(at, current.window) ? current : null;
}
