import { ipcMain } from '@platform';
import { IPC_CHANNELS } from '@shared/types';
import type { AppExitReason, RestartOverlayState, RestartWaitReason } from '@shared/types/ipc';
import { switchNode } from '../services/nodeRemote';
import { isMainRenderer, localMainContents } from '../services/renderers';
import { sendToWindow } from '../windows/createAppWindow';
import { getMainWindow } from '../windows/MainWindow';

/** 弹层归谁开：哪条退出路径（「正在重启」归 restart），或新实例恢复会话；关弹层只认它 */
export type RestartOverlayOwner = AppExitReason | 'resuming';

let current: RestartOverlayState | null = null;

function ownerOf(state: RestartOverlayState): RestartOverlayOwner {
  if (state.phase === 'waiting') return state.exit;
  return state.phase === 'restarting' ? 'restart' : 'resuming';
}

/**
 * 弹层只推给本机主窗口；主窗口还没加载好时记下，挂载时来取。
 * 开弹层时盖着远程节点就切回本机界面，弹层才看得见
 */
export function setRestartOverlay(next: RestartOverlayState | null): void {
  current = next;
  const win = getMainWindow();
  if (!win || win.isDestroyed()) return;
  if (next) switchNode('local');
  sendToWindow(win, IPC_CHANNELS.APP_RESTART_WAITING, next);
}

/** 只关自己开的弹层：恢复结束 / 超时、退出等完不能把别的路径随后开的弹层关掉 */
export function clearRestartOverlay(owner: RestartOverlayOwner): void {
  if (current && ownerOf(current) === owner) setRestartOverlay(null);
}

/** 安装更新 / 退出等安全点期间 worker 报告有命令在跑就开弹层，等完（含出错）先关弹层再返回 */
export async function waitWithExitDialog<T>(
  exit: AppExitReason,
  prepare: (onWaitingForTools: (reason: RestartWaitReason) => void) => Promise<T>
): Promise<T> {
  let done = false;
  try {
    return await prepare((reason) => {
      if (!done) setRestartOverlay({ phase: 'waiting', reason, exit });
    });
  } finally {
    done = true;
    clearRestartOverlay(exit);
  }
}

/**
 * 等待弹层的「强制退出」：只认主窗口，且在等命令时才生效，交给开弹层的那条路径；
 * 取弹层状态只回本机主窗口（节点页面 / 远程浏览器不显示）
 */
export function registerAppRestartHandlers(forceQuit: (exit: AppExitReason) => void): void {
  ipcMain.on(IPC_CHANNELS.APP_RESTART_FORCE, (event) => {
    if (current?.phase === 'waiting' && isMainRenderer(event.sender.id)) forceQuit(current.exit);
  });
  ipcMain.handle(IPC_CHANNELS.APP_RESTART_WAITING_GET, (event) =>
    localMainContents()?.id === event.sender.id ? current : null
  );
}
