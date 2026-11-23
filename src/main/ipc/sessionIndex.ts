import path from 'node:path';
import { app } from '@platform';
import { AgentSessionIndex } from '../services/agentSessionIndex';
import { backgroundTaskStates } from '../services/backgroundTaskTracker';
import { readSettings } from './settings';

export const agentSessionIndex = new AgentSessionIndex({
  readSettings,
  sessionDir: () => path.join(app.getPath('userData'), 'agent', 'sessions'),
});

/**
 * 退出 / 重启 / 安装更新要不要先等 agent 安全点：有根回合或子代理回合在跑，或回合已结束但还有后台命令在跑
 * （重启要落断点、把空闲会话写进恢复清单供命令结束时唤醒；普通退出要让转后台命令挡住退出并弹等待层）
 */
export function needsQuitCheckpoint(): boolean {
  return (
    agentSessionIndex.runningRootSessionIds().length > 0 ||
    agentSessionIndex.hasRunningChild() ||
    backgroundTaskStates.hasRunning()
  );
}
