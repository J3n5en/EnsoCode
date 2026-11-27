import { type ChildProcess, spawn } from 'node:child_process';
import { createJsonRpcConnection, type JsonRpcConnection } from './connection';
import { stopProcessGroup } from './processGroup';

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
  let stopping = false;
  let rpc: JsonRpcConnection;
  const stop = () => {
    if (stopping) return Promise.resolve();
    stopping = true;
    rpc?.close();
    try {
      child.stdin?.end();
    } catch {
      // 管道已关
    }
    return stopOwned(child);
  };
  rpc = createJsonRpcConnection(
    (line) => {
      child.stdin?.write(line);
    },
    {
      onFault: () => {
        void stop();
      },
    }
  );
  child.stdout?.setEncoding('utf8');
  child.stdout?.on('data', (chunk: string) => rpc.push(chunk));
  child.once('exit', () => rpc.close());
  child.once('error', () => rpc.close());
  return { rpc, kill: stop };
}

function stopOwned(child: ChildProcess): Promise<void> {
  if (process.platform === 'win32') {
    try {
      child.kill('SIGTERM');
    } catch {
      // 已经退出
    }
    return Promise.resolve();
  }
  return stopProcessGroup(child.pid).then(() => undefined);
}
