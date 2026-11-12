import path from 'node:path';
import { parseAgentCommand } from '@shared/types/agent';
import { rejectUnparsableCommand } from './commandRejection';
import { installCrashRecord } from './crashRecord';
import { installPiCursorExecHook } from './cursor/installHook';
import { bootstrapWorkerProxyFromEnv } from './proxyEnv';
import { SessionSupervisor } from './supervisor';

// 先按继承 env 装代理 dispatcher，再让任何模块发网络请求
bootstrapWorkerProxyFromEnv();
// pi-cursor 的 h2-bridge spawn 改进程内 HTTP/2；qi/Kg 挂本进程
installPiCursorExecHook();

// 桌面走 utilityProcess.parentPort；服务器走 child_process.fork 的 IPC。
const port = workerPort();

const dataDir = process.env.ENSO_AGENT_DATA_DIR;
if (!dataDir) {
  throw new Error('ENSO_AGENT_DATA_DIR is required');
}
installCrashRecord(dataDir);

const supervisor = new SessionSupervisor({
  emit: (event) => port.postMessage(event),
  agentDir: path.join(dataDir, 'pi-agent'),
  sessionDir: path.join(dataDir, 'sessions'),
  workflowDir: path.join(dataDir, 'workflows'),
  dataDir,
});

port.onMessage((data) => {
  const command = parseAgentCommand(data);
  if (!command) {
    // 静默丢弃会让 Main 只能等到 ready 握手超时，且无任何诊断信息。
    // 契约漂移（如 spawn 字段白名单与生产端不一致）必须在这里就看得见。
    const type = (data as { type?: unknown } | null)?.type;
    console.warn(
      `[agent] dropped unparsable command: ${typeof type === 'string' ? type : '<unknown>'}`
    );
    const rejection = rejectUnparsableCommand(data);
    if (rejection) port.postMessage(rejection);
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

function workerPort(): {
  postMessage(message: unknown): void;
  onMessage(listener: (data: unknown) => void): void;
} {
  const parent = process.parentPort;
  if (parent) {
    return {
      postMessage: (message) => parent.postMessage(message),
      onMessage: (listener) => parent.on('message', (event) => listener(event.data)),
    };
  }
  if (typeof process.send === 'function') {
    const send = process.send.bind(process);
    return {
      postMessage: (message) => {
        send(message);
      },
      onMessage: (listener) => process.on('message', listener),
    };
  }
  throw new Error('agent worker has no parent channel');
}
