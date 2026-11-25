import { ipcMain } from '@platform';
import {
  type AppExitReason,
  IPC_CHANNELS,
  type RestartBlocker,
  type RestartOverlayState,
  type RestartWaitReason,
} from '@shared/types/ipc';
import { switchNode } from '../services/nodeRemote';
import { anyRendererFocused, isMainRenderer, localMainContents } from '../services/renderers';
import { sendToWindow } from '../windows/createAppWindow';
import { getMainWindow } from '../windows/MainWindow';
import { presentWindow } from '../windows/verifyLaunch';

/** 弹层归谁开：哪条退出路径（「正在重启」归 restart），或新实例恢复会话；关弹层只认它 */
export type RestartOverlayOwner = AppExitReason | 'resuming';

let current: RestartOverlayState | null = null;

function sameOverlay(left: RestartOverlayState | null, right: RestartOverlayState | null): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function ownerOf(state: RestartOverlayState): RestartOverlayOwner {
  if (state.phase === 'waiting') return state.exit;
  return state.phase === 'restarting' ? 'restart' : 'resuming';
}

/**
 * 弹层只推给本机主窗口；主窗口还没加载好时记下，挂载时来取。
 * 开弹层时盖着远程节点就切回本机界面；开始等命令时用户正在用本应用（如在设置页里点的重启更新），
 * 把主窗口唤到前台让弹层看得见；后台自动重启不抢别的应用的焦点
 */
export function setRestartOverlay(next: RestartOverlayState | null): void {
  if (sameOverlay(current, next)) return;
  const startsWaiting = next?.phase === 'waiting' && current?.phase !== 'waiting';
  current = next;
  const win = getMainWindow();
  if (!win || win.isDestroyed()) return;
  if (next) switchNode('local');
  sendToWindow(win, IPC_CHANNELS.APP_RESTART_WAITING, next);
  if (startsWaiting && anyRendererFocused()) presentWindow(win);
}

/** 只关自己开的弹层：恢复结束 / 超时、退出等完不能把别的路径随后开的弹层关掉 */
export function clearRestartOverlay(owner: RestartOverlayOwner): void {
  if (current && ownerOf(current) === owner) setRestartOverlay(null);
}

/** 安装更新 / 退出等安全点期间 worker 报告有命令在跑就开弹层，等完（含出错）先关弹层再返回 */
export async function waitWithExitDialog<T>(
  exit: AppExitReason,
  prepare: (
    onWaitingForTools: (reason: RestartWaitReason, blockers?: RestartBlocker[]) => void
  ) => Promise<T>
): Promise<T> {
  let done = false;
  try {
    return await prepare((reason, blockers) => {
      if (!done) {
        setRestartOverlay({
          phase: 'waiting',
          reason,
          exit,
          ...(blockers?.length ? { blockers } : {}),
        });
      }
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
