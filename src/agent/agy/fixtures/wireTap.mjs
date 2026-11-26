// 夹在 Enso 和 agy 之间，逐行记下双向 JSON-RPC。只给 AGY_LIVE 的真机测试用。
// 用法：node wireTap.mjs <log> <agy> ...args
import { spawn } from 'node:child_process';
import { appendFileSync } from 'node:fs';

const [log, command, ...args] = process.argv.slice(2);
const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'] });

function tap(direction, source, sink) {
  let buffer = '';
  source.setEncoding('utf8');
  source.on('data', (chunk) => {
    sink.write(chunk);
    buffer += chunk;
    let newline = buffer.indexOf('\n');
    while (newline >= 0) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (line.trim())
        appendFileSync(log, `${JSON.stringify({ at: Date.now(), direction, line })}\n`);
      newline = buffer.indexOf('\n');
    }
  });
}

tap('out', process.stdin, child.stdin);
tap('in', child.stdout, process.stdout);
child.stderr.setEncoding('utf8');
child.stderr.on('data', (chunk) =>
  appendFileSync(log, `${JSON.stringify({ at: Date.now(), direction: 'stderr', line: chunk })}\n`)
);
process.stdin.on('end', () => child.stdin.end());
child.on('exit', (code) => process.exit(code ?? 0));
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    child.kill(signal);
    setTimeout(() => process.exit(0), 500).unref();
  });
}
