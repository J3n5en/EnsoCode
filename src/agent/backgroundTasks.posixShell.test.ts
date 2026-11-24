import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import { SHELL_LIMITS } from '@shared/shellLimits';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BackgroundTaskManager,
  createTaskTools,
  type TaskEvents,
  withBackground,
} from './backgroundTasks';
import { createSessionCommandTool } from './sessionShell';
import { processAlive } from './shell/detachedRun';

// 模拟 Linux 主机：/bin/sh（以及 shell:true）是 dash，bash 专有写法在那里会失败
const h = vi.hoisted(() => ({
  dash: '/bin/dash',
  spawns: [] as Array<{ file: string; args: string[]; shell: unknown }>,
}));

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  const spawn = (file: string, ...rest: unknown[]) => {
    const args = Array.isArray(rest[0]) ? (rest[0] as string[]) : [];
    const options = (Array.isArray(rest[0]) ? rest[1] : rest[0]) as
      | Record<string, unknown>
      | undefined;
    h.spawns.push({ file, args, shell: options?.shell });
    const target = file === '/bin/sh' ? h.dash : file;
    const next = options?.shell === true ? { ...options, shell: h.dash } : options;
    return Array.isArray(rest[0])
      ? actual.spawn(target, args, next as never)
      : actual.spawn(target, next as never);
  };
  return { ...actual, default: { ...actual, spawn }, spawn };
});

const limits = { ...SHELL_LIMITS, yieldDefaultMs: 80, yieldBuildMs: 80, yieldServerMs: 80 };
const pids: number[] = [];

beforeEach(() => {
  h.spawns.length = 0;
});

afterEach(() => {
  for (const pid of pids.splice(0)) {
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {}
  }
});

const until = (pred: () => boolean, ms = 5000) =>
  vi.waitFor(() => expect(pred()).toBe(true), { timeout: ms, interval: 10 });

function setup(logDir = mkdtempSync(path.join(tmpdir(), 'enso-bg-posix-'))) {
  const ended: string[] = [];
  const events: TaskEvents = {
    onStarted: () => {},
    onOutput: () => {},
    onEnded: (_s, taskId) => ended.push(taskId),
    onCompletionNotify: () => {},
  };
  const manager = new BackgroundTaskManager(events, logDir, limits);
  const tool = withBackground(
    createSessionCommandTool({ cwd: process.cwd() }) as unknown as ToolDefinition,
    manager,
    's1',
    process.cwd()
  );
  const run = async (command: string, background = true) =>
    tool.execute('t1', { command, background }, undefined, undefined, undefined as never);
  const start = async (command: string) =>
    /Started background task (\S+)\./.exec(
      ((await run(command)).content[0] as { text: string }).text
    )?.[1] as string;
  return { manager, run, start, ended, logDir };
}

const spawnOf = (command: string) => h.spawns.find((s) => s.args.at(-1)?.endsWith(command));

describe.runIf(process.platform !== 'win32' && existsSync('/bin/dash'))(
  'POSIX 本地 bash 后台任务与前台同一 shell',
  () => {
    it('后台任务能跑 bash 专有语法', async () => {
      const { manager, start, ended } = setup();
      // biome-ignore lint/suspicious/noTemplateCurlyInString: bash 数组展开
      const taskId = await start('[[ 1 == 1 ]] && arr=(a b) && echo "${arr[1]}"');
      await until(() => ended.includes(taskId));
      const result = await manager.read(taskId);
      expect(result).toMatchObject({ status: 'done', exitCode: 0 });
      expect(result?.output.trim()).toBe('b');
    });

    it('spawn 的 shell 与参数和前台一致', async () => {
      const { run, start, ended } = setup();
      await run('echo enso-fg', false);
      const taskId = await start('echo enso-bg');
      await until(() => ended.includes(taskId));
      const fg = spawnOf('; echo enso-fg');
      const bg = spawnOf('; echo enso-bg');
      expect(fg?.file).toMatch(/bash$/);
      expect(bg?.file).toBe(fg?.file);
      expect(bg?.args.slice(0, -1)).toEqual(fg?.args.slice(0, -1));
      expect(bg?.shell).toBeUndefined();
    });

    it('task_stop 结束整棵进程树（含自立进程组的子孙）', async () => {
      const { manager, start, ended } = setup();
      const dir = mkdtempSync(path.join(tmpdir(), 'enso-bg-posix-tree-'));
      const script = path.join(dir, 'spawner.cjs');
      writeFileSync(
        script,
        "const c = require('node:child_process').spawn('sleep', ['300'], { detached: true, stdio: 'ignore' });\n" +
          "console.log('grandchild=' + c.pid);\n" +
          'setInterval(() => {}, 1000);\n'
      );
      const taskId = await start(`[[ -f "${script}" ]] && "${process.execPath}" "${script}"`);
      let grandchild = 0;
      try {
        await until(() => {
          const tail = manager.snapshot('s1').find((t) => t.taskId === taskId)?.tail ?? '';
          grandchild = Number(/grandchild=(\d+)/.exec(tail)?.[1] ?? 0);
          return grandchild > 0;
        });
        const stop = createTaskTools(manager).find((tool) => tool.name === 'task_stop');
        await stop?.execute('s', { taskId }, undefined, undefined, undefined as never);
        await until(() => ended.includes(taskId));
        await until(() => !processAlive(grandchild), 3000);
      } finally {
        if (grandchild > 0 && processAlive(grandchild)) process.kill(grandchild, 'SIGKILL');
      }
    });

    it('输出直写文件，重启时交出、下一代认回后接着读', async () => {
      const first = setup();
      const taskId = await first.start('for ((i=0; ; i++)); do echo line-$i; sleep 0.03; done');
      await until(() => (first.manager.snapshot('s1')[0]?.tail ?? '').includes('line-3'));
      const [record] = first.manager.detachForRestart();
      expect(record).toMatchObject({ taskId, sessionId: 's1' });
      pids.push(record.pid);
      first.manager.stopAll();
      expect(processAlive(record.pid)).toBe(true);

      const second = setup(first.logDir);
      expect(second.manager.recover([record])).toEqual(new Set([record.runId]));
      const seen = Number(
        /line-(\d+)\n$/.exec(second.manager.snapshot('s1')[0]?.tail ?? '')?.[1] ?? 0
      );
      await until(() =>
        (second.manager.snapshot('s1')[0]?.tail ?? '').includes(`line-${seen + 5}\n`)
      );
      expect(second.manager.stop(taskId)).toBe(true);
      await until(() => !processAlive(record.pid));
    });
  }
);
