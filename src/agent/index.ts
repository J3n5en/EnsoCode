import path from 'node:path';
import { parseAgentCommand } from '@shared/types/agent';
import { installPiCursorExecHook } from './cursor/installHook';
import { SessionSupervisor } from './supervisor';

// pi-cursor 的 h2-bridge spawn 改进程内 HTTP/2；Ju/hi 挂本进程
installPiCursorExecHook();

// agent worker 入口：跑在 utilityProcess 里，与 Main 通过 parentPort 通信。
const port = process.parentPort;

const dataDir = process.env.ENSO_AGENT_DATA_DIR;
if (!dataDir) {
  throw new Error('ENSO_AGENT_DATA_DIR is required');
}

const supervisor = new SessionSupervisor({
  emit: (event) => port.postMessage(event),
  agentDir: path.join(dataDir, 'pi-agent'),
  sessionDir: path.join(dataDir, 'sessions'),
});

port.on('message', (event) => {
  const command = parseAgentCommand(event.data);
  if (!command) {
    // 静默丢弃会让 Main 只能等到 ready 握手超时，且无任何诊断信息。
    // 契约漂移（如 spawn 字段白名单与生产端不一致）必须在这里就看得见。
    const type = (event.data as { type?: unknown } | null)?.type;
    console.warn(
      `[agent] dropped unparsable command: ${typeof type === 'string' ? type : '<unknown>'}`
    );
    return;
  }
  supervisor.handleCommand(command);
});

// utilityProcess.kill() 发 SIGTERM：退出前断开 MCP 连接，别留孤儿子进程
const shutdown = () => {
  void supervisor.shutdown().finally(() => process.exit(0));
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

port.postMessage({ type: 'ready' });
