import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  attachFileBacked,
  defaultRunProbe,
  parseElapsed,
  processAlive,
  processCommandLine,
  readFileTail,
  requestFileBackedRun,
  runFiles,
  spawnFileBacked,
  sweepOrphanRuns,
  withExitTrap,
  withFileBackedExec,
} from './detachedRun';

const posix = process.platform !== 'win32';
const children: ChildProcess[] = [];
const pids: number[] = [];

afterEach(() => {
  for (const child of children.splice(0)) child.kill('SIGKILL');
  for (const pid of pids.splice(0)) {
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {}
  }
});

const until = (pred: () => boolean, ms = 5000) =>
  new Promise<void>((resolve, reject) => {
    const t0 = Date.now();
    const timer = setInterval(() => {
      if (pred()) {
        clearInterval(timer);
        resolve();
      } else if (Date.now() - t0 > ms) {
        clearInterval(timer);
        reject(new Error('timeout'));
      }
    }, 10);
  });

const deadPid = (): number => {
  const result = spawnSync('true');
  return result.pid as number;
};

const shellConfig = () => ({ shell: '/bin/bash', args: ['-c'] });

describe.runIf(posix)('文件直写输出的前台执行', () => {
  const exec = (command: string, signal?: AbortSignal) => {
    const dir = mkdtempSync(path.join(tmpdir(), 'enso-run-'));
    const controller = new AbortController();
    const spawned: Array<{ pid: number; runId: string }> = [];
    requestFileBackedRun(controller.signal, {
      dir,
      onSpawn: (run) => {
        pids.push(run.pid);
        spawned.push(run);
      },
    });
    signal?.addEventListener('abort', () => controller.abort());
    const inner = { exec: vi.fn(async () => ({ exitCode: 99 })) };
    const output: string[] = [];
    const done = withFileBackedExec(inner, shellConfig).exec(command, process.cwd(), {
      onData: (chunk) => output.push(chunk.toString()),
      signal: controller.signal,
    });
    return { dir, done, output, spawned, inner, controller };
  };

  it('退出码、输出与 pi 一致，结束后清掉输出 / 退出码文件', async () => {
    const { dir, done, output, spawned, inner } = exec('echo out; echo err >&2; exit 3');
    await expect(done).resolves.toEqual({ exitCode: 3 });
    expect(inner.exec).not.toHaveBeenCalled();
    expect(output.join('')).toBe('out\nerr\n');
    const files = runFiles(dir, spawned[0].runId);
    expect(existsSync(files.outputFile)).toBe(false);
    expect(existsSync(files.exitFile)).toBe(false);
    expect(existsSync(files.metaFile)).toBe(false);
  });

  it('被信号杀掉按 128+n；中止杀整个进程组并抛 aborted', async () => {
    await expect(exec('kill -TERM $$').done).resolves.toEqual({ exitCode: 143 });
    const outer = new AbortController();
    const run = exec('sleep 30 & wait', outer.signal);
    await until(() => run.spawned.length === 1);
    outer.abort();
    await expect(run.done).rejects.toThrow('aborted');
    await until(() => !processAlive(run.spawned[0].pid));
  });

  it('没登记的调用、带 timeout 的调用照旧交给 pi', async () => {
    const inner = { exec: vi.fn(async () => ({ exitCode: 0 })) };
    const ops = withFileBackedExec(inner, shellConfig);
    await ops.exec('echo x', process.cwd(), { onData: () => {} });
    const controller = new AbortController();
    requestFileBackedRun(controller.signal, { dir: tmpdir(), onSpawn: () => {} });
    await ops.exec('echo x', process.cwd(), {
      onData: () => {},
      signal: controller.signal,
      timeout: 5,
    });
    expect(inner.exec).toHaveBeenCalledTimes(2);
  });

  it('EXIT trap 同一行前置，路径带空格和引号也能写出退出码', () => {
    const dir = mkdtempSync(path.join(tmpdir(), "enso run 'q' "));
    const exitFile = path.join(dir, 'x.exit');
    const result = spawnSync('/bin/bash', ['-c', withExitTrap('echo $LINENO; exit 7', exitFile)], {
      encoding: 'utf8',
    });
    const plain = spawnSync('/bin/bash', ['-c', 'echo $LINENO'], { encoding: 'utf8' });
    expect(result.status).toBe(7);
    // 不改原命令的行号
    expect(result.stdout).toBe(plain.stdout);
    expect(readFileSync(exitFile, 'utf8')).toBe('7');
  });
});

describe.runIf(posix)('交出与认回', () => {
  it('交出后进程照跑、输出继续落文件；认回按偏移接着读，结束时取 trap 写的退出码', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'enso-run-'));
    const run = spawnFileBacked({
      ...shellConfig(),
      command: 'for i in 1 2 3 4 5 6; do echo n$i; sleep 0.05; done; exit 4',
      cwd: process.cwd(),
      dir,
    });
    pids.push(run.pid);
    const seen: string[] = [];
    run.sink((chunk) => seen.push(chunk.toString()));
    await until(() => seen.join('').includes('n2'));
    const offset = run.release();
    const before = seen.join('');
    expect(processAlive(run.pid)).toBe(true);

    const after: string[] = [];
    const attached = attachFileBacked(dir, run, offset);
    attached.sink((chunk) => after.push(chunk.toString()));
    await expect(attached.done).resolves.toEqual({ code: 4, signal: null });
    expect(before + after.join('')).toBe('n1\nn2\nn3\nn4\nn5\nn6\n');
    expect(existsSync(run.outputFile)).toBe(false);
  });

  it('认回的 pid 命令行对不上：kill 不发任何信号', async () => {
    const other = spawn('sleep', ['5']);
    children.push(other);
    const dir = mkdtempSync(path.join(tmpdir(), 'enso-run-'));
    const runId = randomUUID();
    const files = runFiles(dir, runId);
    writeFileSync(files.outputFile, '');
    const attached = attachFileBacked(
      dir,
      { runId, pid: other.pid as number, startedAt: 0, cwd: dir, ...files },
      0,
      { alive: processAlive, matches: () => false }
    );
    attached.kill('SIGKILL');
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(processAlive(other.pid as number)).toBe(true);
    attached.release();
  });

  it('输出文件读不到：readError 报原因，读得到时为 null', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'enso-run-'));
    const runId = randomUUID();
    const files = runFiles(dir, runId);
    const missing = attachFileBacked(
      dir,
      { runId, pid: process.pid, startedAt: 0, cwd: dir, ...files },
      0,
      { alive: () => true, matches: () => false }
    );
    expect(missing.readError()).toMatch(/ENOENT/);
    missing.release();
    writeFileSync(files.outputFile, 'ok\n');
    const present = attachFileBacked(
      dir,
      { runId, pid: process.pid, startedAt: 0, cwd: dir, ...files },
      0,
      { alive: () => true, matches: () => false }
    );
    present.flush();
    expect(present.readError()).toBeNull();
    present.release();
  });

  it('命令 exec 换掉 shell 后命令行里没有 runId：仍认得出是同一进程；启动时间对不上的不认', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'enso-run-'));
    const run = spawnFileBacked({ ...shellConfig(), command: 'exec sleep 30', cwd: dir, dir });
    pids.push(run.pid);
    await until(() => !(processCommandLine(run.pid) ?? run.runId).includes(run.runId));
    expect(defaultRunProbe.matches(run.pid, run)).toBe(true);
    // pid 被复用的进程：没有这次的 runId，启动时间也晚得多
    expect(
      defaultRunProbe.matches(run.pid, { runId: randomUUID(), startedAt: run.startedAt - 60_000 })
    ).toBe(false);
    run.release();
  });
});

describe.runIf(posix)('孤儿清理', () => {
  it('ps 的 etime 换算成毫秒；格式不对返回 null', () => {
    expect(parseElapsed('  00:07\n')).toBe(7_000);
    expect(parseElapsed('01:02:03')).toBe(3_723_000);
    expect(parseElapsed('2-00:00:01')).toBe(172_801_000);
    expect(parseElapsed('')).toBeNull();
    expect(parseElapsed('7')).toBeNull();
  });

  it('登记它的 worker 已不在、命令行带着 runId：杀进程组；worker 还在：不碰', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'enso-run-'));
    const orphan = spawnFileBacked({ ...shellConfig(), command: 'sleep 30', cwd: dir, dir });
    const owned = spawnFileBacked({ ...shellConfig(), command: 'sleep 30', cwd: dir, dir });
    pids.push(orphan.pid, owned.pid);
    orphan.release();
    owned.release();
    const live = spawn('sleep', ['5']);
    children.push(live);
    const meta = (run: typeof orphan, ownerPid: number) =>
      writeFileSync(
        runFiles(dir, run.runId).metaFile,
        JSON.stringify({ version: 1, runId: run.runId, ownerPid, pid: run.pid })
      );
    meta(orphan, deadPid());
    meta(owned, live.pid as number);

    expect(sweepOrphanRuns(dir, new Set())).toEqual([orphan.runId]);
    await until(() => !processAlive(orphan.pid));
    expect(existsSync(runFiles(dir, orphan.runId).metaFile)).toBe(false);
    expect(processAlive(owned.pid)).toBe(true);
    expect(existsSync(runFiles(dir, owned.runId).metaFile)).toBe(true);
  });

  it('pid 已被别的进程占用（命令行对不上）：不杀，只清登记文件；清单里认回的跳过', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'enso-run-'));
    const other = spawn('sleep', ['5']);
    children.push(other);
    const reused = randomUUID();
    const kept = randomUUID();
    for (const runId of [reused, kept]) {
      writeFileSync(
        runFiles(dir, runId).metaFile,
        JSON.stringify({ version: 1, runId, ownerPid: deadPid(), pid: other.pid })
      );
    }
    expect(sweepOrphanRuns(dir, new Set([kept]))).toEqual([]);
    expect(processAlive(other.pid as number)).toBe(true);
    expect(existsSync(runFiles(dir, reused).metaFile)).toBe(false);
    expect(existsSync(runFiles(dir, kept).metaFile)).toBe(true);
  });
});

describe('readFileTail', () => {
  it('只读最后 max 字节，不劈开多字节字符、丢掉被截断的首行；文件不在返回空', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'enso-tail-'));
    const file = path.join(dir, 'a.log');
    writeFileSync(file, `${'x'.repeat(10_000)}\n中文第一行\n最后一行\n`);
    const tail = readFileTail(file, 20).toString('utf8');
    expect(tail).toBe('最后一行\n');
    expect(
      readFileTail(file, 1 << 20)
        .toString('utf8')
        .endsWith('中文第一行\n最后一行\n')
    ).toBe(true);
    writeFileSync(file, 'short\n');
    expect(readFileTail(file, 1024).toString('utf8')).toBe('short\n');
    expect(readFileTail(path.join(dir, 'missing.log'), 1024).length).toBe(0);
  });
});
