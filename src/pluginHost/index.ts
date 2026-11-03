import type { PluginHostToMain } from '@shared/extensionPlugins/protocol';
import { failHostProcess } from './children';
import { captureConsole, runPluginHost } from './host';

/** 桌面走 utilityProcess 的 parentPort，服务端走 child_process 的 IPC */
const parentPort = (
  process as unknown as { parentPort?: NodeJS.EventEmitter & { postMessage(m: unknown): void } }
).parentPort;

const send = (message: PluginHostToMain) => {
  if (parentPort) parentPort.postMessage(message);
  else process.send?.(message);
};

captureConsole(console, send);

runPluginHost({
  send,
  onMessage: (handler) => {
    if (parentPort) parentPort.on('message', (event: { data: unknown }) => handler(event.data));
    else process.on('message', handler);
  },
});

process.on('uncaughtException', (error) => {
  failHostProcess(
    error,
    (message) => send({ t: 'log', level: 'error', message }),
    (code) => process.exit(code)
  );
});

process.on('unhandledRejection', (reason) => {
  send({
    t: 'log',
    level: 'error',
    message: `unhandledRejection: ${reason instanceof Error ? (reason.stack ?? reason.message) : String(reason)}`,
  });
});
