import path from 'node:path';
import { parseAgentCommand } from '@shared/types/agent';
import { SessionSupervisor } from './supervisor';

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

port.postMessage({ type: 'ready' });
