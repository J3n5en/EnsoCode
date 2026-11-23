// pnpm test：不带参数是全量（node --test 脚本测试 + vitest），在本机排队串行；带参数时只把参数交给 vitest run，不排队。
import { spawn } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { acquireFullTestLock } from './test-lock.mjs';

export const NODE_TEST_FILES = readdirSync(fileURLToPath(new URL('.', import.meta.url)))
  .filter((name) => name.endsWith('.test.mjs'))
  .map((name) => `scripts/${name}`);

let child;
function run(command, args) {
  return new Promise((resolve) => {
    child = spawn(command, args, { stdio: 'inherit' });
    child.on('exit', (code, signal) => resolve(code ?? (signal ? 1 : 0)));
  });
}

const vitestBin = fileURLToPath(new URL('../node_modules/vitest/vitest.mjs', import.meta.url));

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.on(signal, () => {
      child?.kill(signal);
      process.exit(130);
    });
  }
  const args = process.argv.slice(2);
  if (args.length) {
    process.exit(await run(process.execPath, [vitestBin, 'run', ...args]));
  }
  const release = await acquireFullTestLock();
  const code =
    (await run(process.execPath, ['--test', ...NODE_TEST_FILES])) ||
    (await run(process.execPath, [vitestBin, 'run']));
  release();
  process.exit(code);
}
