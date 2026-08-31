import { describe, expect, it } from 'vitest';
import type { SshExecOptions, SshExecutor } from '../ssh/executor';
import { createRemoteCheckpointHost } from './remoteHost';

interface Call {
  command: string[] | string;
  options?: SshExecOptions;
}

function fakeExecutor(respond: (call: Call) => { stdout?: string; code?: number } = () => ({})) {
  const calls: Call[] = [];
  const executor = {
    host: 'h',
    async exec(command: string[] | string, options?: SshExecOptions) {
      const call: Call = { command, options };
      calls.push(call);
      const r = respond(call);
      return { stdout: r.stdout ?? '', stderr: 'boom', code: r.code ?? 0 };
    },
    async execRaw() {
      throw new Error('unused');
    },
    async execStream() {
      throw new Error('unused');
    },
  } as unknown as SshExecutor;
  return { calls, executor };
}

describe('createRemoteCheckpointHost', () => {
  it('git:引号感知拆参,env 覆盖项经 env 前缀,input 走 stdin,失败抛 stderr', async () => {
    const { calls, executor } = fakeExecutor((call) =>
      Array.isArray(call.command) && call.command.join(' ').includes('fail')
        ? { code: 128 }
        : { stdout: '  abc123\n' }
    );
    const host = createRemoteCheckpointHost(executor);
    const out = await host.git('add --all -- "a b.txt"', '/srv/repo', {
      env: { GIT_INDEX_FILE: '/tmp/idx' },
      input: 'msg',
    });
    expect(out).toBe('abc123');
    expect(calls[0].command).toEqual([
      'env',
      'GIT_INDEX_FILE=/tmp/idx',
      'git',
      'add',
      '--all',
      '--',
      'a b.txt',
    ]);
    expect(calls[0].options).toMatchObject({ cwd: '/srv/repo' });
    expect(calls[0].options?.stdin?.toString()).toBe('msg');
    await expect(host.git('fail-cmd', '/srv/repo')).rejects.toThrow('boom');
  });

  it('statBatch:路径列表走 stdin,解析 kind/size(路径含空格安全)', async () => {
    const { calls, executor } = fakeExecutor(() => ({
      stdout: 'd 0 some dir\nf 42 a b.txt\nm 0 gone.txt\n',
    }));
    const host = createRemoteCheckpointHost(executor);
    const map = await host.statBatch('/srv/repo', ['some dir', 'a b.txt', 'gone.txt']);
    expect(map.get('some dir')).toEqual({ kind: 'dir', size: 0 });
    expect(map.get('a b.txt')).toEqual({ kind: 'file', size: 42 });
    expect(map.get('gone.txt')).toEqual({ kind: 'missing', size: 0 });
    expect(calls[0].options?.stdin?.toString()).toBe('some dir\na b.txt\ngone.txt\n');
  });

  it('statBatch 空列表不发命令', async () => {
    const { calls, executor } = fakeExecutor();
    const host = createRemoteCheckpointHost(executor);
    const map = await host.statBatch('/srv/repo', []);
    expect(map.size).toBe(0);
    expect(calls).toHaveLength(0);
  });

  it('mkdtemp 用远端 mktemp -d;rmrf 用 rm -rf;join 恒为 posix', async () => {
    const { calls, executor } = fakeExecutor(() => ({ stdout: '/tmp/enso-checkpoint-x1\n' }));
    const host = createRemoteCheckpointHost(executor);
    await expect(host.mkdtemp()).resolves.toBe('/tmp/enso-checkpoint-x1');
    await host.rmrf('/tmp/enso-checkpoint-x1');
    expect(calls[1].command).toEqual(['rm', '-rf', '--', '/tmp/enso-checkpoint-x1']);
    expect(host.join('/tmp/x', 'index')).toBe('/tmp/x/index');
  });
});
