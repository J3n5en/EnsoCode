import type { BashOperations } from '@earendil-works/pi-coding-agent';
import { describe, expect, it } from 'vitest';
import { createSessionCommandTool, resolveSessionShellKind } from './sessionShell';

describe('resolveSessionShellKind', () => {
  it('远程会话即便在 win32 上也选 bash', () => {
    expect(resolveSessionShellKind({ platform: 'win32', remote: true })).toBe('bash');
  });

  it('本地 win32 选 powershell', () => {
    expect(resolveSessionShellKind({ platform: 'win32' })).toBe('powershell');
  });

  it('本地非 win32(如 darwin)选 bash', () => {
    expect(resolveSessionShellKind({ platform: 'darwin' })).toBe('bash');
  });

  it('本地 win32 偏好 bash 时选 bash', () => {
    expect(resolveSessionShellKind({ platform: 'win32', preference: 'bash' })).toBe('bash');
  });

  it('本地 win32 偏好 powershell 或 auto 时选 powershell', () => {
    expect(resolveSessionShellKind({ platform: 'win32', preference: 'auto' })).toBe('powershell');
    expect(resolveSessionShellKind({ platform: 'win32', preference: 'powershell' })).toBe(
      'powershell'
    );
  });

  it('远程忽略偏好,仍选 bash', () => {
    expect(
      resolveSessionShellKind({ platform: 'win32', remote: true, preference: 'powershell' })
    ).toBe('bash');
  });

  it('非 win32 强制 powershell 也不生效', () => {
    expect(resolveSessionShellKind({ platform: 'darwin', preference: 'powershell' })).toBe('bash');
  });

  it('远程且非 win32 也选 bash', () => {
    expect(resolveSessionShellKind({ platform: 'linux', remote: true })).toBe('bash');
  });
});

describe('createSessionCommandTool', () => {
  it('本地 win32 建出的工具名为 powershell', () => {
    const tool = createSessionCommandTool({ cwd: '/tmp', platform: 'win32' });
    expect(tool.name).toBe('powershell');
  });

  it('本地 win32 偏好 bash 时建出 bash', () => {
    const tool = createSessionCommandTool({
      cwd: '/tmp',
      platform: 'win32',
      preference: 'bash',
    });
    expect(tool.name).toBe('bash');
  });

  it('远程 win32 建出的工具名仍为 bash', () => {
    const tool = createSessionCommandTool({ cwd: '/tmp', platform: 'win32', remote: true });
    expect(tool.name).toBe('bash');
  });

  it('本地 darwin 建出的工具名为 bash', () => {
    const tool = createSessionCommandTool({ cwd: '/tmp', platform: 'darwin' });
    expect(tool.name).toBe('bash');
  });

  it('不传 platform 时按 process.platform 判断', () => {
    const tool = createSessionCommandTool({ cwd: '/tmp' });
    expect(tool.name).toBe(process.platform === 'win32' ? 'powershell' : 'bash');
  });

  it.skipIf(process.platform === 'win32')('本地命令跑在非交互硬化环境里', async () => {
    const tool = createSessionCommandTool({ cwd: process.cwd() });
    const result = await tool.execute(
      't1',
      { command: 'printf "%s|%s|%s" "$GIT_TERMINAL_PROMPT" "$PAGER" "$NO_COLOR"' },
      undefined,
      undefined,
      undefined as never
    );
    const text = result.content.map((part) => (part.type === 'text' ? part.text : '')).join('');
    expect(text).toContain('0|cat|1');
  });

  it('远程（外部传入的 operations）不注入本地硬化 env', async () => {
    const seen: Array<NodeJS.ProcessEnv | undefined> = [];
    const operations: BashOperations = {
      exec: async (_command, _cwd, options) => {
        seen.push(options.env);
        return { exitCode: 0 };
      },
    };
    const tool = createSessionCommandTool({ cwd: '/srv/app', remote: true, operations });
    await tool.execute('t1', { command: 'true' }, undefined, undefined, undefined as never);
    expect(seen[0]?.GIT_TERMINAL_PROMPT).toBeUndefined();
  });
});
