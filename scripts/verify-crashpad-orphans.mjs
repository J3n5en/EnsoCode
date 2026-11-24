#!/usr/bin/env node
// macOS：主进程开 crashReporter 后 spawn caffeinate，再退出，统计残留的 crashpad_handler / caffeinate。
// 用法：node scripts/verify-crashpad-orphans.mjs [--runs 3] [--no-wait-pid]
// ELECTRON_BIN 可指定 Electron 可执行文件；默认 require('electron')。
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

if (process.platform !== 'darwin') {
  console.log('skip: macOS only');
  process.exit(0);
}

const argv = process.argv.slice(2);
const runs = Number(argv[argv.indexOf('--runs') + 1]) || 3;
const waitPid = !argv.includes('--no-wait-pid');
const electron = process.env.ELECTRON_BIN || createRequire(import.meta.url)('electron');
const root = mkdtempSync(join(tmpdir(), 'enso-crashpad-'));

writeFileSync(
  join(root, 'main.cjs'),
  `const { app, crashReporter } = require('electron');
const { spawn } = require('node:child_process');
app.setPath('userData', ${JSON.stringify(join(root, 'userData'))});
app.setPath('crashDumps', ${JSON.stringify(join(root, 'Crashpad'))});
crashReporter.start({ uploadToServer: false });
app.whenReady().then(() => {
  const args = ${waitPid} ? ['-w', String(process.pid), '-i', '-s'] : ['-i', '-s'];
  const child = spawn('/usr/bin/caffeinate', args, { stdio: 'ignore' });
  process.stdout.write('caffeinate=' + child.pid + '\\n');
  setTimeout(() => app.exit(0), 1500);
});
`
);
writeFileSync(join(root, 'package.json'), '{"name":"crashpad-orphan-probe","main":"main.cjs"}');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const handlers = () =>
  execFileSync('ps', ['-axo', 'pid=,command='], { encoding: 'utf8' })
    .split('\n')
    .filter(
      (l) => l.includes('crashpad_handler') && l.includes(`--database=${join(root, 'Crashpad')}`)
    )
    .map((l) => Number(l.trim().split(/\s+/)[0]));

const caffeinates = [];
for (let i = 1; i <= runs; i++) {
  const child = spawn(electron, [root], { stdio: ['ignore', 'pipe', 'ignore'] });
  child.stdout.on('data', (d) => {
    const m = /caffeinate=(\d+)/.exec(String(d));
    if (m) caffeinates.push(Number(m[1]));
  });
  await new Promise((r) => child.on('exit', r));
  await sleep(1500);
  console.log(
    `run ${i}: crashpad_handler=${handlers().length} caffeinate=${caffeinates.filter(alive).length}`
  );
}

const leaked = handlers().length;
for (const pid of caffeinates.filter(alive)) process.kill(pid, 'SIGTERM');
await sleep(1500);
const afterCaffeinate = handlers();
for (const pid of afterCaffeinate) process.kill(pid, 'SIGTERM');
rmSync(root, { recursive: true, force: true });
console.log(
  `${waitPid ? 'caffeinate -w <pid>' : 'caffeinate 无 -w'}: ${runs} 次退出后残留 ${leaked} 个 handler，` +
    `结束残留 caffeinate 后剩 ${afterCaffeinate.length} 个`
);
process.exit(waitPid && leaked > 0 ? 1 : 0);
