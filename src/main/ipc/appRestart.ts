import { ipcMain } from '@platform';
import { IPC_CHANNELS } from '@shared/types';
import type { AppExitReason, RestartWaitReason } from '@shared/types/ipc';
import { switchNode } from '../services/nodeRemote';
import { isMainRenderer } from '../services/renderers';
import { sendToWindow } from '../windows/createAppWindow';
import { getMainWindow } from '../windows/MainWindow';

/** 弹层当前归哪条退出路径；关弹层与「强制退出」都只认它 */
let shownFor: AppExitReason | null = null;

/**
 * 重启 / 安装更新 / 退出在等命令结束：主窗口开 / 关等待弹层，说明在等哪种命令、等完做什么。
 * 只推给主窗口；盖着远程节点时先切回本机界面，弹层才看得见。
 */
export function notifyRestartWaiting(
  waiting: boolean,
  reason?: RestartWaitReason,
  exit: AppExitReason = 'restart'
): void {
  if (!waiting && shownFor !== exit) return;
  shownFor = waiting ? exit : null;
  const win = getMainWindow();
  if (!win || win.isDestroyed()) return;
  if (waiting) switchNode('local');
  sendToWindow(
    win,
    IPC_CHANNELS.APP_RESTART_WAITING,
    waiting,
    waiting ? (reason ?? 'tool') : undefined,
    waiting ? exit : undefined
  );
}

/** 等安全点期间 worker 报告有命令在跑就开弹层，等完（含出错）先关弹层再返回 */
export async function waitWithExitDialog<T>(
  exit: AppExitReason,
  prepare: (onWaitingForTools: (reason: RestartWaitReason) => void) => Promise<T>
): Promise<T> {
  let done = false;
  try {
    return await prepare((reason) => {
      if (!done) notifyRestartWaiting(true, reason, exit);
    });
  } finally {
    done = true;
    notifyRestartWaiting(false, undefined, exit);
  }
}

/** 等待弹层的「强制退出」：只认主窗口，且弹层开着时才生效，交给开弹层的那条路径 */
export function registerAppRestartHandlers(forceQuit: (exit: AppExitReason) => void): void {
  ipcMain.on(IPC_CHANNELS.APP_RESTART_FORCE, (event) => {
    if (shownFor && isMainRenderer(event.sender.id)) forceQuit(shownFor);
  });
}
