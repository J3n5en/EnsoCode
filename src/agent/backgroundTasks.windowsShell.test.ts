import { EventEmitter } from 'node:events';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import { SHELL_LIMITS } from '@shared/shellLimits';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BackgroundTaskManager, type TaskEvents, withBackground } from './backgroundTasks';
import { withRtkOptimization } from './rtk';

type ShellConfig = { shell: string; args: string[]; commandTransport?: 'argv' | 'stdin' };

const h = vi.hoisted(() => ({
  shell: undefined as ShellConfig | undefined,
  fakes: [] as Array<{ file: string; args: string[]; options: Record<string, unknown> }>,
  children: [] as unknown[],
  stdin: [] as string[],
}));

vi.mock('@earendil-works/pi-coding-agent', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@earendil-works/pi-coding-agent')>()),
  getShellConfig: () => {
    if (!h.shell) throw new Error('No bash shell found');
    return h.shell;
  },
}));

// 只拦 Windows 程序（bash.exe / taskkill.exe）；其余（假 rtk 二进制）照常真跑
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  const spawn = (file: string, ...rest: unknown[]) => {
    if (!/\.exe$/i.test(file) && !rest.some((r) => (r as { shell?: unknown })?.shell === true))
      return (actual.spawn as (...a: unknown[]) => unknown)(file, ...rest);
    const args = Array.isArray(rest[0]) ? (rest[0] as string[]) : [];
    const options = (Array.isArray(rest[0]) ? rest[1] : rest[0]) as Record<string, unknown>;
    h.fakes.push({ file, args, options });
    const child = Object.assign(new EventEmitter(), {
      pid: 4242,
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
      stdin: {
        on: () => {},
        write: (chunk: string) => h.stdin.push(chunk),
        end: (chunk?: string) => {
          if (chunk !== undefined) h.stdin.push(chunk);
        },
      },
      kill: () => true,
    });
    h.children.push(child);
    // taskkill /T /F 在真实 Windows 上必杀死目标进程；mock 的 child 自己不会退出，
    // 不补这一刀，stop() 的强制收口链（killGraceMs 级定时器）会跨测试窗口迟到
    // 额外的 taskkill spawn，污染后续用例的 fakes 断言——机器忙时偶发 6 vs 1。
    if (/taskkill\.exe$/i.test(file)) {
      // 所有 mock child 共享 pid 4242，taskkill 的目标就是它们；对已存在的 bash child
      // 补 close，任务当场收口，升级/强制 settle 定时器自动失效。
      const targets = h.children.slice(0, -1);
      queueMicrotask(() => {
        for (const target of targets) (target as EventEmitter).emit('close', 0, null);
      });
    }
    return child;
  };
  return { ...actual, default: { ...actual, spawn }, spawn };
});

const GIT_BASH = { shell: 'C:\\Program Files\\Git\\bin\\bash.exe', args: ['-c'] };
const MSYS2 = { shell: 'C:\\msys64\\usr\\bin\\bash.exe', args: ['-c'] };
const WSL = {
  shell: 'C:\\Windows\\System32\\bash.exe',
  args: ['-s'],
  commandTransport: 'stdin' as const,
};

const realPlatform = process.platform;
const dirs: string[] = [];
const tempDir = (prefix: string) => {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
};

beforeEach(() => {
  Object.defineProperty(process, 'platform', { value: 'win32' });
  // 上个用例留下的 child 永远不退出的话，其 manager 的 watchdog（500ms 一轮）
  // 会把它们当成「进程消失」反复 taskkill——mock 的 pid 4242 在高负载下还可能
  // 撞上本机真实存活进程，spawn 漏进当前用例的 fakes 窗口（偶发 6 vs 1 失败）。
  // 测试边界即这些模拟进程的寿命终点：close 后任务当场收口，watchdog 不再碰。
  for (const child of h.children) (child as EventEmitter).emit('close', 0, null);
  h.shell = undefined;
  h.fakes.length = 0;
  h.children.length = 0;
  h.stdin.length = 0;
});

afterEach(() => {
  Object.defineProperty(process, 'platform', { value: realPlatform });
});

// 任务日志异步落盘，目录留到全部用例结束再删
afterAll(async () => {
  await new Promise((resolve) => setTimeout(resolve, 50));
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function setup(definition: ToolDefinition = bashTool()) {
  const ended: Array<{ status: string; exitCode?: number }> = [];
  let tail = '';
  const events: TaskEvents = {
    onStarted: () => {},
    onOutput: (_s, _id, next) => {
      tail = next;
    },
    onEnded: (_s, _id, status, exitCode) => ended.push({ status, exitCode }),
    onCompletionNotify: () => {},
  };
  const manager = new BackgroundTaskManager(events, tempDir('enso-bg-win-'), SHELL_LIMITS);
  const tool = withBackground(definition, manager, 's1', 'C:\\proj');
  const run = async (command: string) => {
    const result = await tool.execute(
      'call-1',
      { command, background: true },
      undefined,
      undefined,
      undefined as never
    );
    return /Started background task (\S+)\./.exec(
      (result.content[0] as { text: string }).text
    )?.[1] as string;
  };
  return { manager, run, ended, tail: () => tail };
}

function bashTool(): ToolDefinition {
  return {
    name: 'bash',
    label: 'bash',
    description: '',
    parameters: { type: 'object', properties: {} },
    execute: async () => ({ content: [], details: undefined }),
  } as unknown as ToolDefinition;
}

/** pi 前台 createLocalShellOperations 的起法：argv 追加命令；stdin 只给 args，命令写进 stdin */
function foregroundSpawn(config: ShellConfig, command: string) {
  const stdin = config.commandTransport === 'stdin';
  return {
    file: config.shell,
    args: stdin ? config.args : [...config.args, command],
    stdio: [stdin ? 'pipe' : 'ignore', 'pipe', 'pipe'],
    stdinText: stdin ? [command] : [],
  };
}

describe('Windows 本地 bash 后台任务与前台同一 shell', () => {
  const command = "export A=1 && echo '$A' | cat";

  it.each([
    ['Git Bash', GIT_BASH],
    ['MSYS2', MSYS2],
    ['WSL（stdin 传命令）', WSL],
  ] as const)('%s：spawn 的 shell 与参数和前台一致，不经 cmd.exe', async (_name, config) => {
    h.shell = config;
    const { run } = setup();
    await run(command);
    const expected = foregroundSpawn(config, command);
    expect(h.fakes).toHaveLength(1);
    const [call] = h.fakes;
    expect(call.file).toBe(expected.file);
    expect(call.args).toEqual(expected.args);
    expect(call.options.shell).toBeUndefined();
    expect(call.options).toMatchObject({
      cwd: 'C:\\proj',
      detached: false,
      windowsHide: true,
      stdio: expected.stdio,
    });
    expect(h.stdin).toEqual(expected.stdinText);
  });

  it('WSL：输出照常收、退出码照常结算', async () => {
    h.shell = WSL;
    const { run, ended, tail } = setup();
    await run('echo hi; exit 3');
    const child = h.children[0] as EventEmitter & { stdout: EventEmitter };
    child.stdout.emit('data', Buffer.from('hi\n'));
    child.emit('close', 3, null);
    await vi.waitFor(() => expect(ended).toHaveLength(1));
    expect(ended[0]).toEqual({ status: 'failed', exitCode: 3 });
    expect(tail()).toMatch(/hi/);
  });

  it.each([
    ['Git Bash', GIT_BASH],
    ['WSL', WSL],
  ] as const)('%s：结束任务走 System32 taskkill /T /F 整树结束', async (_name, config) => {
    h.shell = config;
    const { manager, run } = setup();
    const taskId = await run('sleep 100');
    expect(manager.stop(taskId)).toBe(true);
    const kill = h.fakes.find((c) => /taskkill\.exe$/i.test(c.file));
    expect(kill?.file).toMatch(/[\\/]System32[\\/]taskkill\.exe$/);
    expect(kill?.args).toEqual(['/pid', '4242', '/T', '/F']);
  });

  it('找不到 bash 时报错，不静默落到 cmd.exe', async () => {
    const { run } = setup();
    await expect(run('echo hi')).rejects.toThrow(/No bash shell found/);
    expect(h.fakes).toHaveLength(0);
  });

  it('RTK 改写后的命令在后台路径上交给 bash', async () => {
    h.shell = GIT_BASH;
    const home = tempDir('enso-rtk-bin-');
    const binaryPath = path.join(home, 'rtk');
    writeFileSync(
      binaryPath,
      `#!/usr/bin/env node
if (process.argv[2] === 'rewrite') { process.stdout.write('rtk git status'); process.exit(3); }
`
    );
    chmodSync(binaryPath, 0o755);
    const optimized = withRtkOptimization(bashTool(), {
      binaryPath,
      dataDir: tempDir('enso-rtk-data-'),
      cwd: process.cwd(),
    });
    const { run } = setup(optimized);
    await run('git status');
    expect(h.fakes).toHaveLength(1);
    const [call] = h.fakes;
    expect(call.file).toBe(GIT_BASH.shell);
    expect(call.args[0]).toBe('-c');
    expect(call.args[1]).toMatch(/rtk\(\) \{/);
    expect(call.options.shell).toBeUndefined();
  });
});
