import { type ChildProcess, spawn } from 'node:child_process';
import { killProcessTree } from '../killTree';
import { createJsonRpcConnection, type JsonRpcConnection } from './connection';

export interface AgyProcess {
  rpc: JsonRpcConnection;
  kill(): Promise<void>;
}

export function startAgyProcess(options: {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
}): AgyProcess {
  const child = spawn(options.command, options.args, {
    cwd: options.cwd,
    env: options.env,
    detached: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const rpc = createJsonRpcConnection((line) => {
    child.stdin?.write(line);
  });
  child.stdout?.setEncoding('utf8');
  child.stdout?.on('data', (chunk: string) => rpc.push(chunk));
  const closed = () => rpc.close();
  child.once('exit', closed);
  child.once('error', closed);
  return { rpc, kill: () => stopChild(child, rpc) };
}

function stopChild(child: ChildProcess, rpc: JsonRpcConnection): Promise<void> {
  rpc.close();
  try {
    child.stdin?.end();
  } catch {
    // 管道已关
  }
  killProcessTree(child, 'SIGTERM');
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      killProcessTree(child, 'SIGKILL');
      resolve();
    }, 1000);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}
