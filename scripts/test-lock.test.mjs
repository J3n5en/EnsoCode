import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { acquireFullTestLock, scanQueue } from './test-lock.mjs';

const DEAD_PID = 2_147_483_646;
const tempQueue = () => mkdtempSync(join(tmpdir(), 'test-lock-'));
function enqueue(dir, pid, startedAt, mtimeMs = Date.now()) {
  const file = join(dir, `${String(startedAt).padStart(15, '0')}-${pid}.json`);
  writeFileSync(file, JSON.stringify({ pid, cwd: `/repo/${pid}`, startedAt }));
  utimesSync(file, mtimeMs / 1000, mtimeMs / 1000);
  return file;
}

test('队列按先来后到排，进程已死或心跳过期的条目被清掉', () => {
  const dir = tempQueue();
  const now = Date.now();
  enqueue(dir, DEAD_PID, 1);
  enqueue(dir, process.ppid, 2, now - 10 * 60_000);
  enqueue(dir, process.pid, 4);
  enqueue(dir, process.ppid, 3);
  const { live } = scanQueue(dir, { now, staleMs: 60_000 });
  assert.deepEqual(
    live.map((entry) => entry.startedAt),
    [3, 4]
  );
  assert.equal(readdirSync(dir).length, 2);
});

test('前面有人时排队并报告人数；前面的进程崩溃（pid 消失）后自动拿到锁，释放后删掉自己的条目', async () => {
  const dir = tempQueue();
  const ahead = enqueue(dir, process.ppid, 1);
  const logs = [];
  let acquired = false;
  const pending = acquireFullTestLock({ dir, pollMs: 10, log: (line) => logs.push(line) }).then(
    (release) => {
      acquired = true;
      return release;
    }
  );
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(acquired, false);
  assert.match(logs.join('\n'), /有 1 个全量在排队/);
  writeFileSync(ahead, JSON.stringify({ pid: DEAD_PID, cwd: '/crashed', startedAt: 1 }));
  const release = await pending;
  assert.deepEqual(readdirSync(dir).length, 1);
  release();
  assert.deepEqual(readdirSync(dir), []);
});

test('空队列立即拿到锁', async () => {
  const dir = tempQueue();
  const release = await acquireFullTestLock({ dir, log: () => {} });
  assert.equal(readdirSync(dir).length, 1);
  release();
  release();
  assert.equal(readdirSync(dir).length, 0);
});
