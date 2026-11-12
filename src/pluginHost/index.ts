import { failHostProcess } from './children';
import { captureConsole, createProcessTransport, runPluginHost } from './host';

const transport = createProcessTransport(process);
const send = transport.send;

captureConsole(console, send);

runPluginHost(transport);

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
