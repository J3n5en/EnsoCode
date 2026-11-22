export {
  QUIT_REPLY_IDLE_MS,
  QUIT_REPLY_WAIT_CAP_MS,
  QUIT_REPLY_WAIT_FLOOR_MS,
  replyWaitDeadline,
} from '@shared/quitLimits';

/** 退出 / 安装更新前有工具在跑：等它结束，最多等这么久；超时中止命令照常退出。也是等安全点的总上限 */
export const QUIT_TOOL_WAIT_LIMIT_MS = 5 * 60_000;
