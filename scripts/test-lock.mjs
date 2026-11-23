// 本机全量测试排队：每个全量进程在共享目录里放一个条目，按先来后到只让队首运行。
// 条目的进程已退出（pid 不在）或心跳超时就视为崩溃残留，任何人看到都可以清掉。
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const QUEUE_DIR = join(tmpdir(), 'enso-code-full-test-queue');
const HEARTBEAT_MS = 5_000;
const STALE_MS = 60_000;

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

export function scanQueue(dir, { now = Date.now(), staleMs = STALE_MS } = {}) {
  const live = [];
  for (const name of readdirSync(dir).sort()) {
    const file = join(dir, name);
    try {
      const entry = JSON.parse(readFileSync(file, 'utf8'));
      if (isAlive(entry.pid) && now - statSync(file).mtimeMs <= staleMs) {
        live.push({ ...entry, file });
        continue;
      }
    } catch (error) {
      if (error.code === 'ENOENT') continue;
    }
    rmSync(file, { force: true });
  }
  return { live };
}

/** 排到队首才返回；返回的 release 删掉自己的条目，可重复调用 */
export async function acquireFullTestLock({
  dir = QUEUE_DIR,
  pollMs = 1_000,
  log = console.log,
} = {}) {
  mkdirSync(dir, { recursive: true });
  const startedAt = Date.now();
  const file = join(dir, `${String(startedAt).padStart(15, '0')}-${process.pid}.json`);
  const body = JSON.stringify({ pid: process.pid, cwd: process.cwd(), startedAt });
  const touch = () => {
    try {
      const now = new Date();
      utimesSync(file, now, now);
    } catch {
      writeFileSync(file, body);
    }
  };
  writeFileSync(file, body);
  const heartbeat = setInterval(touch, HEARTBEAT_MS);
  heartbeat.unref();
  const release = () => {
    clearInterval(heartbeat);
    rmSync(file, { force: true });
  };
  process.once('exit', release);

  let reported = '';
  for (;;) {
    touch();
    const { live } = scanQueue(dir);
    const index = live.findIndex((entry) => entry.file === file);
    if (index === 0) {
      if (reported)
        log(`[test-lock] 轮到本次全量，排队 ${Math.round((Date.now() - startedAt) / 1000)}s`);
      return release;
    }
    const ahead = live.slice(0, Math.max(index, 0));
    const status = `[test-lock] 有 ${ahead.length} 个全量在排队（正在跑：pid ${ahead[0]?.pid} ${ahead[0]?.cwd}），等待中…`;
    if (status !== reported) log(status);
    reported = status;
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}
