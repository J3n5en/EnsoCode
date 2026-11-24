import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { killProcessTree, ownGroupDescendants, treeGroups } from './killTree';

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
    killProcessTree(child, 'SIGTERM', {
      platform: 'darwin',
      spawn,
      killGroup,
      listProcesses: () => [],
    });
    expect(killGroup).toHaveBeenCalledWith(-99, 'SIGTERM');
    expect(spawn).not.toHaveBeenCalled();

    const broken = fakeChild(99);
    killProcessTree(broken, 'SIGTERM', {
      platform: 'linux',
      spawn,
      listProcesses: () => [],
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

describe('treeGroups', () => {
  const entry = (pid: number, ppid: number, pgid: number) => ({ pid, ppid, pgid });

  it('包含后代自立的进程组和组里过继给 init 的成员，不含无关进程', () => {
    const table = [
      entry(10, 9, 10),
      entry(11, 10, 10),
      entry(12, 11, 12),
      entry(13, 12, 12),
      entry(14, 1, 12),
      entry(15, 14, 15),
      entry(20, 1, 20),
    ];
    expect(treeGroups(10, table, new Set(), 999).sort()).toEqual([10, 12, 15]);
  });

  it('根已退出时靠见过的组认回过继给 init 的后代；已无成员的组丢掉', () => {
    const table = [entry(12, 1, 12), entry(13, 12, 12), entry(16, 13, 16), entry(20, 1, 20)];
    expect(treeGroups(10, table, new Set([10, 12, 77]), 999).sort()).toEqual([10, 12, 16]);
  });

  it('不碰自己所在的组和 init，也不顺着它们扩散到别的进程', () => {
    const table = [
      entry(10, 9, 10),
      entry(11, 10, 5),
      entry(12, 10, 1),
      entry(999, 1, 5),
      entry(1000, 999, 1000),
      entry(2, 1, 1),
      entry(3, 2, 3),
    ];
    expect(treeGroups(10, table, new Set(), 999)).toEqual([10]);
  });
});

describe('ownGroupDescendants', () => {
  const entry = (pid: number, ppid: number, pgid: number) => ({ pid, ppid, pgid });

  it('只列根的后代里和自己同组的进程，不含根、自己和别的同组进程', () => {
    const table = [
      entry(999, 1, 5),
      entry(10, 999, 5),
      entry(11, 10, 5),
      entry(12, 11, 12),
      entry(13, 12, 5),
      entry(20, 999, 5),
    ];
    expect(ownGroupDescendants(10, table, 999).sort()).toEqual([11, 13]);
  });
});
