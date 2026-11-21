import { type ChildProcess, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import { SHELL_LIMITS } from '@shared/shellLimits';
import { afterEach, describe, expect, it } from 'vitest';
import { BackgroundTaskManager, type TaskEvents, withBackground } from './backgroundTasks';
import {
  type DetachedTaskRecord,
  takeDetachedTasksManifest,
  writeDetachedTasksManifest,
} from './detachedTasksManifest';
import { createSessionCommandTool } from './sessionShell';
import { processAlive, runFiles } from './shell/detachedRun';

const posix = process.platform !== 'win32';
const limits = { ...SHELL_LIMITS, yieldDefaultMs: 80, yieldBuildMs: 80, yieldServerMs: 80 };
const cleanup: number[] = [];
const children: ChildProcess[] = [];

afterEach(() => {
  for (const pid of cleanup.splice(0)) {
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {}
  }
  for (const child of children.splice(0)) child.kill('SIGKILL');
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

function makeManager(logDir: string) {
  const notified: Array<{ text: string; durable: boolean }> = [];
  const ended: string[] = [];
  const events: TaskEvents = {
    onStarted: () => {},
    onOutput: () => {},
    onEnded: (_s, taskId) => ended.push(taskId),
    onCompletionNotify: (_s, text, options) =>
      notified.push({ text, durable: options?.durable === true }),
  };
  return { manager: new BackgroundTaskManager(events, logDir, limits), notified, ended };
}

const shell = (manager: BackgroundTaskManager) =>
  withBackground(
    createSessionCommandTool({ cwd: process.cwd() }) as unknown as ToolDefinition,
    manager,
    's1',
    process.cwd()
  );

const textOf = (result: { content: Array<{ type: string; text?: string }> }) =>
  result.content.map((part) => (part.type === 'text' ? part.text : '')).join('');

/** 跑一条前台命令，到让位时刻转后台，返回任务 id */
async function yieldCommand(manager: BackgroundTaskManager, command: string): Promise<string> {
  const result = await shell(manager).execute(
    't1',
    { command },
    undefined,
    undefined,
    undefined as never
  );
  return (result.details as { backgroundTaskId: string }).backgroundTaskId;
}

const LOOP = 'i=0; while true; do echo line-$i; i=$((i+1)); sleep 0.03; done';

describe.runIf(posix)('重启时转后台命令脱离 worker、下一代认回', () => {
  it('pid 还在：同一个任务 id 认回为 running，面板尾部接上重启前的输出、不丢不重；同一命令不再重复启动', async () => {
    const logDir = mkdtempSync(path.join(tmpdir(), 'enso-bg-restart-'));
    const first = makeManager(logDir);
    const taskId = await yieldCommand(first.manager, LOOP);
    await until(() => (first.manager.snapshot('s1')[0]?.tail ?? '').includes('line-3'));
    const [record] = first.manager.detachForRestart();
    cleanup.push(record.pid);
    expect(record).toMatchObject({ taskId, sessionId: 's1', cwd: process.cwd() });
    expect(first.manager.snapshot('s1')).toEqual([]);
    // 旧 worker 收尾停任务：已交出的不在它手里
    first.manager.stopAll();
    const consumed = readFileSync(record.outputFile).subarray(0, record.outputOffset).toString();
    const lastSeen = Number(/line-(\d+)\n$/.exec(consumed)?.[1]);
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(processAlive(record.pid)).toBe(true);

    const second = makeManager(logDir);
    expect(second.manager.recover([record])).toEqual(new Set([record.runId]));
    expect(second.manager.snapshot('s1')).toEqual([
      expect.objectContaining({ taskId, status: 'running' }),
    ]);
    await until(() =>
      (second.manager.snapshot('s1')[0]?.tail ?? '').includes(`line-${lastSeen + 10}\n`)
    );
    const resumed = second.manager.snapshot('s1')[0]?.tail ?? '';
    expect(resumed).toContain(`line-${lastSeen}\nline-${lastSeen + 1}\n`);
    expect(resumed.match(new RegExp(`(^|\\n)line-${lastSeen}\\n`, 'g'))).toHaveLength(1);
    expect(second.manager.snapshot('s1')[0]?.outputBytes).toBeGreaterThan(record.outputOffset);
    // 日志接着写在同一份文件里
    expect(readFileSync(record.logPath, 'utf8')).toContain(`line-${lastSeen}\n`);

    const again = await shell(second.manager).execute(
      't2',
      { command: LOOP },
      undefined,
      undefined,
      undefined as never
    );
    expect(textOf(again)).toContain(`already running as background task ${taskId}`);
    expect(second.manager.snapshot('s1')).toHaveLength(1);

    expect(second.manager.stop(taskId)).toBe(true);
    await until(() => !processAlive(record.pid));
    await until(() => second.ended.includes(taskId));
  });

  it('认回后输出文件读不到：面板看到读取失败的原因，而不是「暂无输出」', async () => {
    const logDir = mkdtempSync(path.join(tmpdir(), 'enso-bg-restart-'));
    const sleeper = spawn('sleep', ['30'], { detached: true });
    children.push(sleeper);
    const runId = randomUUID();
    const files = runFiles(logDir, runId);
    const { manager } = makeManager(logDir);
    manager.recover(
      [
        {
          taskId: 'task-3-gone-file',
          sessionId: 's1',
          command: 'server',
          commandKey: null,
          cwd: logDir,
          pid: sleeper.pid as number,
          runId,
          startedAt: Date.now(),
          yieldedAt: null,
          deadlineAt: null,
          outputFile: files.outputFile,
          outputOffset: 0,
          exitCodeFile: files.exitFile,
          logPath: path.join(logDir, 'task-3-gone-file.log'),
        },
      ],
      { alive: () => true, matches: () => true }
    );
    try {
      await until(() =>
        (manager.snapshot('s1')[0]?.tail ?? '').includes('cannot read command output')
      );
      expect(manager.snapshot('s1')[0]?.tail).toMatch(/ENOENT/);
    } finally {
      manager.stop('task-3-gone-file');
    }
  });

  it('认回时只把日志尾部读进内存；重启前的输出不当作新输出重放给模型', () => {
    const logDir = mkdtempSync(path.join(tmpdir(), 'enso-bg-restart-'));
    const taskId = 'task-7-old';
    const runId = randomUUID();
    const files = runFiles(logDir, runId);
    const before = `${Array.from({ length: 200_000 }, (_, i) => `pre-${i}`).join('\n')}\npre-last\n`;
    writeFileSync(path.join(logDir, `${taskId}.log`), before);
    writeFileSync(files.outputFile, 'pre-last\npost-1\n');
    writeFileSync(files.exitFile, '0');
    const record: DetachedTaskRecord = {
      taskId,
      sessionId: 's1',
      command: 'loop',
      commandKey: null,
      cwd: logDir,
      pid: 999_999,
      runId,
      startedAt: Date.now() - 60_000,
      yieldedAt: null,
      deadlineAt: null,
      outputFile: files.outputFile,
      outputOffset: 'pre-last\n'.length,
      exitCodeFile: files.exitFile,
      logPath: path.join(logDir, `${taskId}.log`),
    };
    const started: Array<{ tail: string; outputBytes?: number }> = [];
    const notified: string[] = [];
    const manager = new BackgroundTaskManager(
      {
        onStarted: (_s, task) => started.push(task),
        onOutput: () => {},
        onEnded: () => {},
        onCompletionNotify: (_s, text) => notified.push(text),
      },
      logDir,
      limits
    );
    manager.recover([record], { alive: () => false, matches: () => false });

    expect(started[0]?.tail).toContain('pre-199999\npre-last\npost-1\n');
    const [info] = manager.snapshot('s1');
    expect(info?.tail).toContain('pre-last\npost-1\n');
    expect(info?.tail.length).toBeLessThanOrEqual(8_000);
    expect(info?.outputBytes).toBe(Buffer.byteLength(before) + 'post-1\n'.length);
    expect(notified).toHaveLength(1);
    expect(notified[0]).toContain('post-1');
    expect(notified[0]).not.toContain('pre-last');
  });

  it('命令 exec 换掉了 shell（命令行里已没有 trap 和 runId）：照样认回为 running，停止时停得掉', async () => {
    const logDir = mkdtempSync(path.join(tmpdir(), 'enso-bg-restart-'));
    const first = makeManager(logDir);
    const taskId = await yieldCommand(first.manager, 'exec sleep 30');
    const [record] = first.manager.detachForRestart();
    cleanup.push(record.pid);
    first.manager.stopAll();
    expect(processAlive(record.pid)).toBe(true);

    const second = makeManager(logDir);
    second.manager.recover([record]);
    expect(second.manager.snapshot('s1')).toEqual([
      expect.objectContaining({ taskId, status: 'running' }),
    ]);
    expect(second.manager.stop(taskId)).toBe(true);
    await until(() => !processAlive(record.pid));
    await until(() => second.ended.includes(taskId));
  });

  it('pid 已不在：读完输出文件收尾，按 trap 写的退出码标记并照常（落盘）通知', async () => {
    const logDir = mkdtempSync(path.join(tmpdir(), 'enso-bg-restart-'));
    const first = makeManager(logDir);
    const failing = await yieldCommand(first.manager, 'echo one; sleep 0.3; echo two; exit 3');
    const passing = await yieldCommand(first.manager, 'echo ok-start; sleep 0.3; echo ok-end');
    const records = first.manager.detachForRestart();
    expect(records.map((record) => record.taskId)).toEqual([failing, passing]);
    for (const record of records) cleanup.push(record.pid);
    await until(() => records.every((record) => !processAlive(record.pid)));

    const second = makeManager(logDir);
    second.manager.recover(records);
    await until(() => second.ended.length === 2);
    const [failed, done] = await Promise.all([
      second.manager.read(failing),
      second.manager.read(passing),
    ]);
    expect(failed).toMatchObject({ status: 'failed', exitCode: 3 });
    expect(failed?.output).toContain('two');
    expect(done).toMatchObject({ status: 'done', exitCode: 0 });
    expect(done?.output).toContain('ok-end');
    expect(second.notified).toEqual([
      { text: expect.stringContaining(`Background task ${failing}`), durable: true },
      {
        text: expect.stringContaining(`Background task ${passing} finished (exit 0`),
        durable: true,
      },
    ]);
    expect(existsSync(records[0].outputFile)).toBe(false);
  });

  it('pid 被别的进程复用（命令行对不上）：不认、不杀，标记找不到原进程并通知', async () => {
    const logDir = mkdtempSync(path.join(tmpdir(), 'enso-bg-restart-'));
    const stranger = spawn('sleep', ['5']);
    children.push(stranger);
    const runId = randomUUID();
    const files = runFiles(logDir, runId);
    writeFileSync(files.outputFile, 'old output\n');
    const record: DetachedTaskRecord = {
      taskId: 'task-1-abc',
      sessionId: 's1',
      command: 'pnpm dev',
      commandKey: null,
      cwd: logDir,
      pid: stranger.pid as number,
      runId,
      startedAt: Date.now() - 60_000,
      yieldedAt: Date.now() - 50_000,
      deadlineAt: null,
      outputFile: files.outputFile,
      outputOffset: 0,
      exitCodeFile: files.exitFile,
      logPath: path.join(logDir, 'task-1-abc.log'),
    };
    const second = makeManager(logDir);
    second.manager.recover([record]);
    await until(() => second.ended.includes('task-1-abc'));
    const task = await second.manager.read('task-1-abc');
    expect(task?.status).toBe('failed');
    expect(task?.output).toContain('original process not found after restart');
    expect(second.manager.stop('task-1-abc')).toBe(false);
    expect(second.notified[0]?.text).toContain('original process not found');
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(processAlive(stranger.pid as number)).toBe(true);
  });

  it('恢复清单只记命令摘要：命令行与环境变量里的密钥都不落盘', async () => {
    const logDir = mkdtempSync(path.join(tmpdir(), 'enso-bg-restart-'));
    const envSecret = 'env-only-token-0123456789abcdef';
    process.env.ENSO_TEST_ACCESS_TOKEN = envSecret;
    const secrets = [
      'sk-live-0123456789abcdefghijkl',
      'ghp_0123456789abcdefghijklmnopqrstuv',
      'hunter2-password-value',
    ];
    try {
      const first = makeManager(logDir);
      await yieldCommand(
        first.manager,
        `OPENAI_API_KEY=${secrets[0]} GITHUB_TOKEN=${secrets[1]} sleep 5; echo --password ${secrets[2]} $ENSO_TEST_ACCESS_TOKEN`
      );
      const records = first.manager.detachForRestart();
      for (const record of records) cleanup.push(record.pid);
      const file = path.join(logDir, 'restart-background-tasks.json');
      writeDetachedTasksManifest(file, {
        version: 1,
        writtenAt: Date.now(),
        workerPid: process.pid,
        tasks: records,
      });
      const raw = readFileSync(file, 'utf8');
      for (const secret of [...secrets, envSecret]) expect(raw).not.toContain(secret);
      expect(raw).toContain('OPENAI_API_KEY=[REDACTED]');
      expect(Object.keys(JSON.parse(raw).tasks[0]).sort()).toEqual(
        [
          'taskId',
          'sessionId',
          'command',
          'commandKey',
          'cwd',
          'pid',
          'runId',
          'startedAt',
          'runStartedAt',
          'yieldedAt',
          'deadlineAt',
          'outputFile',
          'outputOffset',
          'exitCodeFile',
          'logPath',
        ].sort()
      );
      // 读后即删；路径被改到 logDir 之外的条目整条丢弃
      expect(takeDetachedTasksManifest(file, logDir)).toHaveLength(1);
      expect(existsSync(file)).toBe(false);
      writeDetachedTasksManifest(file, {
        version: 1,
        writtenAt: Date.now(),
        workerPid: process.pid,
        tasks: records.map((record) => ({ ...record, outputFile: '/etc/passwd' })),
      });
      expect(takeDetachedTasksManifest(file, logDir)).toEqual([]);
    } finally {
      delete process.env.ENSO_TEST_ACCESS_TOKEN;
    }
  });

  it('走管道的进程（没有文件直写句柄）留在原处，不进恢复清单', async () => {
    const logDir = mkdtempSync(path.join(tmpdir(), 'enso-bg-restart-'));
    const { manager } = makeManager(logDir);
    const exit = Promise.withResolvers<number | null>();
    const taskId = manager.adopt(
      's1',
      { output: () => '', pipe: () => {}, done: exit.promise, kill: () => exit.resolve(null) },
      { command: 'ssh host make', startedAt: Date.now() }
    );
    expect(manager.runningYielded('s1', { exceptDetachable: true })).toEqual([taskId]);
    expect(manager.detachForRestart()).toEqual([]);
    expect(manager.snapshot('s1')).toEqual([
      expect.objectContaining({ taskId, status: 'running' }),
    ]);
    manager.stopAll();
  });
});
