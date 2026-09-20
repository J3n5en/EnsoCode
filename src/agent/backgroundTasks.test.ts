import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import type { BackgroundTaskInfo } from '@shared/types/agent';
import { describe, expect, it } from 'vitest';
import {
  attachBackgroundCommandHooks,
  BackgroundTaskManager,
  createTaskTools,
  DEFAULT_FOREGROUND_BASH_TIMEOUT_SEC,
  resolveBackgroundLaunch,
  type TaskEvents,
  withBackground,
  withForegroundBashTimeout,
} from './backgroundTasks';

const makeManager = () => {
  const notified: string[] = [];
  const ended: string[] = [];
  const started: BackgroundTaskInfo[] = [];
  const events: TaskEvents = {
    onStarted: (_sessionId, task) => started.push(task),
    onOutput: () => {},
    onEnded: (_s, taskId) => ended.push(taskId),
    onCompletionNotify: (_s, text) => notified.push(text),
  };
  const manager = new BackgroundTaskManager(events, mkdtempSync(path.join(tmpdir(), 'enso-bg-')));
  return { manager, notified, ended, started };
};

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
    }, 50);
  });

describe('withForegroundBashTimeout', () => {
  it('前台未指定 timeout 时填默认秒数', () => {
    expect(withForegroundBashTimeout({ command: 'sleep 1' })).toEqual({
      command: 'sleep 1',
      timeout: DEFAULT_FOREGROUND_BASH_TIMEOUT_SEC,
    });
  });

  it('模型显式 timeout 保留', () => {
    expect(withForegroundBashTimeout({ command: 'sleep 1', timeout: 30 })).toEqual({
      command: 'sleep 1',
      timeout: 30,
    });
  });

  it('background 不注入 timeout', () => {
    expect(withForegroundBashTimeout({ command: 'sleep 999', background: true })).toEqual({
      command: 'sleep 999',
      background: true,
    });
  });
});

describe('withBackground promptSnippet 跟随工具名', () => {
  it('包装 powershell 工具时,promptSnippet 以 powershell: 开头而非 bash:', () => {
    const manager = makeManager().manager;
    const base = {
      name: 'powershell',
      label: 'powershell',
      description: '',
      parameters: { type: 'object', properties: {} },
      execute: async () => ({ content: [], details: undefined }),
    } as unknown as ToolDefinition;
    const wrapped = withBackground(base, manager, 's1', '/tmp');
    expect(wrapped.promptSnippet).toMatch(/^powershell:/);
  });
});

describe('resolveBackgroundLaunch', () => {
  it('给了 transform 时优先用 transform 的结果,不带 file', () => {
    const result = resolveBackgroundLaunch('bash', 'echo hi', '/srv/app', (command, cwd) => ({
      command: `ssh ${command}`,
      cwd: `${cwd}/x`,
    }));
    expect(result).toEqual({ command: 'ssh echo hi', cwd: '/srv/app/x' });
  });

  it('工具名为 powershell 且无 transform 时,带上 resolvePowerShell 给出的 file/argsPrefix', () => {
    const result = resolveBackgroundLaunch(
      'powershell',
      'Get-Process',
      'C:\\proj',
      undefined,
      () => ({ shell: 'pwsh.exe', args: ['-NoProfile', '-Command'] })
    );
    expect(result).toEqual({
      command: 'Get-Process',
      cwd: 'C:\\proj',
      file: 'pwsh.exe',
      argsPrefix: ['-NoProfile', '-Command'],
    });
  });

  it('工具名为 bash 且无 transform 时,只回原样 command/cwd', () => {
    const result = resolveBackgroundLaunch('bash', 'echo hi', '/tmp');
    expect(result).toEqual({ command: 'echo hi', cwd: '/tmp' });
  });
});

describe('withBackground 命令变换(远程会话用)', () => {
  it('内部包装命令不泄露到 TaskInfo 与完成通知', async () => {
    const originalCommand = 'echo visible-command';
    const wrappedCommand = 'RTK_DB_PATH=/private/history.db echo visible-command';
    const base = attachBackgroundCommandHooks(
      {
        name: 'bash',
        label: 'bash',
        description: '',
        parameters: { type: 'object', properties: {} },
        execute: async () => ({ content: [], details: undefined }),
      } as unknown as ToolDefinition,
      { prepare: async () => ({ command: wrappedCommand }) }
    );
    const { manager, ended, notified, started } = makeManager();
    const wrapped = withBackground(base, manager, 's1', '/tmp');

    await wrapped.execute(
      't1',
      { command: originalCommand, background: true },
      undefined,
      undefined,
      undefined as never
    );
    await until(() => ended.length === 1);

    expect(started[0].command).toBe(originalCommand);
    expect(started[0].command).not.toContain('RTK_DB_PATH');
    expect(notified[0]).toContain(`Command: ${originalCommand}`);
    expect(notified[0]).not.toContain('RTK_DB_PATH');
  });

  it('prepare 后已取消则不启动后台，且 cleanup 异常不覆盖 AbortError', async () => {
    const controller = new AbortController();
    const base = {
      name: 'bash',
      label: 'bash',
      description: '',
      parameters: { type: 'object', properties: {} },
      execute: async () => ({ content: [], details: undefined }),
    } as unknown as ToolDefinition;
    const prepared = attachBackgroundCommandHooks(base, {
      async prepare() {
        controller.abort();
        return {
          command: 'echo should-not-run',
          finalize: async () => {
            throw new Error('cleanup failed');
          },
        };
      },
    });
    const { manager } = makeManager();
    let started = false;
    manager.start = (() => {
      started = true;
      return 'task-1';
    }) as typeof manager.start;
    const wrapped = withBackground(prepared, manager, 's1', '/tmp');

    await expect(
      wrapped.execute(
        't1',
        { command: 'echo should-not-run', background: true },
        controller.signal,
        undefined,
        undefined as never
      )
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(started).toBe(false);
  });

  it('传入 transform 时,background 命令经变换后交给 manager', async () => {
    const { manager } = makeManager();
    const base = {
      name: 'bash',
      label: 'bash',
      description: '',
      parameters: { type: 'object', properties: {} },
      execute: async () => ({ content: [], details: undefined }),
    } as unknown as ToolDefinition;
    const wrapped = withBackground(base, manager, 's1', '/srv/app', (command, cwd) => ({
      command: `ssh h ${JSON.stringify(`cd ${cwd} && ${command}`)}`,
      cwd: process.cwd(),
    }));
    const startCalls: { command: string; cwd: string }[] = [];
    manager.start = ((_sessionId: string, command: string, cwd: string) => {
      startCalls.push({ command, cwd });
      return 'task-1';
    }) as typeof manager.start;
    await wrapped.execute(
      't1',
      { command: 'sleep 999', background: true },
      undefined,
      undefined,
      undefined as never
    );
    expect(startCalls[0].command).toBe('ssh h "cd /srv/app && sleep 999"');
    expect(startCalls[0].cwd).toBe(process.cwd());
  });

  it('前台 execute 注入默认 timeout', async () => {
    const { manager } = makeManager();
    const seen: unknown[] = [];
    const base = {
      name: 'bash',
      label: 'bash',
      description: '',
      parameters: { type: 'object', properties: {} },
      execute: async (_id: string, params: unknown) => {
        seen.push(params);
        return { content: [], details: undefined };
      },
    } as unknown as ToolDefinition;
    const wrapped = withBackground(base, manager, 's1', '/tmp');
    await wrapped.execute('t1', { command: 'echo hi' }, undefined, undefined, undefined as never);
    expect(seen[0]).toEqual({
      command: 'echo hi',
      timeout: DEFAULT_FOREGROUND_BASH_TIMEOUT_SEC,
    });
  });
});

describe('BackgroundTaskManager', () => {
  it('进程退出后等待 finalize，再由 task_output 返回最终 details', async () => {
    const { manager, ended } = makeManager();
    let finishFinalize: ((details: unknown) => void) | undefined;
    const finalized = new Promise<unknown>((resolve) => {
      finishFinalize = resolve;
    });
    const taskId = manager.start('s1', 'printf finalized; sleep 0.2', '/tmp', {
      details: { rtk: { status: 'pending', originalCommand: 'echo finalized' } },
      finalize: () => finalized,
    });
    await until(() => manager.snapshot('s1')[0]?.tail.includes('finalized') ?? false);
    expect(ended).toHaveLength(0);
    expect((await manager.read(taskId))?.details).toEqual({
      rtk: { status: 'pending', originalCommand: 'echo finalized' },
    });

    finishFinalize?.({ rtk: { status: 'compressed', originalCommand: 'echo finalized' } });
    await until(() => ended.includes(taskId));

    const tool = createTaskTools(manager).find((item) => item.name === 'task_output');
    const result = await tool?.execute(
      'read-1',
      { taskId },
      undefined,
      undefined,
      undefined as never
    );
    expect(result?.details).toEqual({
      rtk: { status: 'compressed', originalCommand: 'echo finalized' },
    });
  });

  it('workspace busy scope includes descendant tasks even without a live session', async () => {
    const { manager, ended } = makeManager();
    const taskId = manager.start('root::cw-child', 'sleep 30', tmpdir());
    try {
      expect(manager.hasRunningInWorkspace(['root'])).toBe(true);
      expect(manager.hasRunningInWorkspace(['roo'])).toBe(false);
      expect(manager.hasRunningInWorkspace(['other'])).toBe(false);
    } finally {
      manager.stop(taskId);
      await until(() => ended.includes(taskId));
    }
    expect(manager.hasRunningInWorkspace(['root'])).toBe(false);
  });

  it('任务完成:输出捕获、exit 事件、未知情则自动通知(含 log 路径)', async () => {
    const { manager, notified, ended } = makeManager();
    const taskId = manager.start('s1', 'echo hello-bg', '/tmp');
    await until(() => ended.length === 1);
    expect(ended).toEqual([taskId]);
    expect(notified).toHaveLength(1);
    expect(notified[0]).toContain('exit 0');
    expect(notified[0]).toContain('task_output');
    const result = await manager.read(taskId);
    expect(result?.output).toContain('hello-bg');
    expect(result?.status).toBe('done');
  });

  it('阻塞等待拿到结束态 → consumed,不再自动通知', async () => {
    const { manager, notified } = makeManager();
    const taskId = manager.start('s1', 'sleep 0.2 && echo done-x', '/tmp');
    const result = await manager.read(taskId, 5000);
    expect(result?.status).toBe('done');
    // 等潜在的通知路径跑完
    await new Promise((r) => setTimeout(r, 100));
    expect(notified).toHaveLength(0);
  });

  it('模型 task_stop → consumed 不通知;用户停止 → 通知含勿重启提示', async () => {
    const { manager, notified, ended } = makeManager();
    const byModel = manager.start('s1', 'sleep 30', '/tmp');
    manager.stop(byModel);
    await until(() => ended.includes(byModel));
    expect(notified).toHaveLength(0);

    const byUser = manager.start('s1', 'sleep 30', '/tmp');
    manager.stop(byUser, true);
    await until(() => ended.includes(byUser));
    expect(notified).toHaveLength(1);
    expect(notified[0]).toContain('do not restart');
  });
});
