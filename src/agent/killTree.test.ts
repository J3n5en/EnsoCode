import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { killProcessTree } from './killTree';

const fakeChild = (pid: number | undefined) => ({ pid, kill: vi.fn(() => true) });

const fakeSpawn = () => {
  const calls: { file: string; args: readonly string[]; opts: unknown }[] = [];
  const procs: EventEmitter[] = [];
  const spawn = vi.fn((file: string, args: readonly string[], opts: unknown) => {
    calls.push({ file, args, opts });
    const proc = new EventEmitter();
    procs.push(proc);
    return proc;
  });
  return { spawn, calls, procs };
};

describe('killProcessTree', () => {
  it('Windows 用 System32 下的 taskkill /T /F 杀整棵树，不走 process.kill(-pid)', () => {
    const child = fakeChild(4242);
    const { spawn, calls } = fakeSpawn();
    const killGroup = vi.fn();
    killProcessTree(child, 'SIGTERM', {
      platform: 'win32',
      systemRoot: 'C:\\Windows',
      spawn,
      killGroup,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.file).toMatch(/^C:\\Windows[\\/]System32[\\/]taskkill\.exe$/);
    expect(calls[0]?.args).toEqual(['/pid', '4242', '/T', '/F']);
    expect(calls[0]?.opts).toMatchObject({ windowsHide: true });
    expect(killGroup).not.toHaveBeenCalled();
    expect(child.kill).not.toHaveBeenCalled();
  });

  it('Windows taskkill 启动失败时退回只杀直接子进程', () => {
    const child = fakeChild(7);
    const { spawn, procs } = fakeSpawn();
    killProcessTree(child, 'SIGKILL', { platform: 'win32', systemRoot: 'C:\\Windows', spawn });
    procs[0]?.emit('error', new Error('ENOENT'));
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
  });

  it('POSIX 向进程组发信号，失败则退回子进程本身', () => {
    const child = fakeChild(99);
    const killGroup = vi.fn();
    const { spawn } = fakeSpawn();
    killProcessTree(child, 'SIGTERM', { platform: 'darwin', spawn, killGroup });
    expect(killGroup).toHaveBeenCalledWith(-99, 'SIGTERM');
    expect(spawn).not.toHaveBeenCalled();

    const broken = fakeChild(99);
    killProcessTree(broken, 'SIGTERM', {
      platform: 'linux',
      spawn,
      killGroup: () => {
        throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' });
      },
    });
    expect(broken.kill).toHaveBeenCalledWith('SIGTERM');
  });

  it('没有 pid（未启动成功）时只调子进程 kill', () => {
    const child = fakeChild(undefined);
    const { spawn } = fakeSpawn();
    killProcessTree(child, 'SIGKILL', { platform: 'win32', systemRoot: 'C:\\Windows', spawn });
    expect(spawn).not.toHaveBeenCalled();
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
  });
});
