import path from 'node:path';
import { parseAgentCommand } from '@shared/types/agent';
import { installPiCursorExecHook } from './cursor/installHook';
import { SessionSupervisor } from './supervisor';

// utilityProcess 的 execPath 是 Electron；pi-cursor 会拿它 spawn h2-bridge
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
  if (command) supervisor.handleCommand(command);
});

// utilityProcess.kill() 发 SIGTERM：退出前断开 MCP 连接，别留孤儿子进程
const shutdown = () => {
  void supervisor.shutdown().finally(() => process.exit(0));
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

port.postMessage({ type: 'ready' });
