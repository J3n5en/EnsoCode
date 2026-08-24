import path from 'node:path';
import { app, type UtilityProcess, utilityProcess } from 'electron';

/** 管理 agent worker（utilityProcess）的生命周期。当前为通路雏形，命令下发后续补。 */
let worker: UtilityProcess | null = null;

export function startAgentWorker(): void {
  if (worker) return;
  const child = utilityProcess.fork(path.join(import.meta.dirname, 'agent.js'), [], {
    serviceName: 'enso-agent-worker',
    env: {
      ...process.env,
      // pi 的全局目录与会话目录都收进 userData，不碰用户的 ~/.pi
      ENSO_AGENT_DATA_DIR: path.join(app.getPath('userData'), 'agent'),
    },
  });
  worker = child;

  child.on('message', (_message) => {
    // 事件上抛在 IPC 通路步骤接入
  });

  child.on('exit', (_code) => {
    // 崩溃/退出后置空，后续在此广播全部会话 failed
    if (worker === child) worker = null;
  });
}

export function stopAgentWorker(): void {
  worker?.kill();
  worker = null;
}
