import { spawn } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ExtensionToolContext } from '@earendil-works/pi-coding-agent';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SshExecResult, SshExecutor } from './executor';
import { createRemoteGrepToolDefinition } from './remoteGrep';

const ctx = undefined as unknown as ExtensionToolContext;

function fakeExecutor(
  handler: (command: string[] | string) => { stdout?: string; stderr?: string; code?: number }
) {
  const calls: (string[] | string)[] = [];
  const executor = {
    host: 'h',
    async exec(command: string[] | string) {
      calls.push(command);
      const r = handler(command);
      return { stdout: r.stdout ?? '', stderr: r.stderr ?? '', code: r.code ?? 0 };
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

describe('createRemoteGrepToolDefinition', () => {
  it('保留原厂 schema/name;首次执行探测 rg 并缓存;输出透传', async () => {
    const { calls, executor } = fakeExecutor((cmd) => {
      if (typeof cmd === 'string' && cmd.includes('command -v rg'))
        return { stdout: '/usr/bin/rg' };
      return { stdout: 'src/a.ts:3:match line\n' };
    });
    const tool = createRemoteGrepToolDefinition('/srv/app', executor);
    expect(tool.name).toBe('grep');
    expect(tool.parameters).toBeDefined();

    const result = await tool.execute('t1', { pattern: 'match' }, undefined, undefined, ctx);
    expect(result.content).toEqual([{ type: 'text', text: 'src/a.ts:3:match line' }]);
    expect(calls.some((c) => typeof c === 'string' && c.includes('rg -n'))).toBe(true);

    await tool.execute('t2', { pattern: 'again' }, undefined, undefined, ctx);
    // rg 探测只发生一次
    expect(calls.filter((c) => typeof c === 'string' && c.includes('command -v rg'))).toHaveLength(
      1
    );
  });

  it('无 rg 时降级 grep;无命中输出 No matches', async () => {
    const { calls, executor } = fakeExecutor((cmd) => {
      if (typeof cmd === 'string' && cmd.includes('command -v rg')) return { code: 1 };
      return { stdout: '', code: 1 };
    });
    const tool = createRemoteGrepToolDefinition('/srv/app', executor);
    const result = await tool.execute('t1', { pattern: 'x' }, undefined, undefined, ctx);
    expect(calls.some((c) => typeof c === 'string' && c.includes('grep -rn'))).toBe(true);
    expect(result.content[0]).toMatchObject({
      type: 'text',
      text: expect.stringMatching(/no matches/i),
    });
  });

  it('退出码 2 但已有命中时返回命中，并附上 stderr 摘要', async () => {
    const { executor } = fakeExecutor((cmd) => {
      if (typeof cmd === 'string' && cmd.includes('command -v rg')) return { code: 1 };
      return {
        stdout: 'ok.txt:1:token-hit\n',
        stderr: 'grep: locked: Permission denied\n',
        code: 2,
      };
    });
    const tool = createRemoteGrepToolDefinition('/srv/app', executor);
    const result = await tool.execute('t1', { pattern: 'token-hit' }, undefined, undefined, ctx);
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain('ok.txt:1:token-hit');
    expect(text).toContain('Permission denied');
  });

  it('退出码 2 且没有输出仍然报错', async () => {
    const { executor } = fakeExecutor((cmd) => {
      if (typeof cmd === 'string' && cmd.includes('command -v rg')) return { code: 1 };
      return { stdout: '', stderr: 'grep: missing-dir: No such file or directory', code: 2 };
    });
    const tool = createRemoteGrepToolDefinition('/srv/app', executor);
    await expect(
      tool.execute('t1', { pattern: 'token-hit' }, undefined, undefined, ctx)
    ).rejects.toThrow(/missing-dir/);
  });
});

/**
 * 本机 bash 冒充远端:字符串脚本在远端经 `bash -lc` 执行(buildRemoteCommand),
 * 这里用 bash -c 跑同一脚本,验证真实管道的退出码与 stderr。rg 探测固定失败,走 grep 降级,
 * 结果不依赖本机是否装了 rg。
 */
function localBashExecutor(options: { ignoreSigpipe?: boolean } = {}): SshExecutor {
  const exec = (command: string[] | string): Promise<SshExecResult> => {
    if (typeof command !== 'string') throw new Error('remote grep 只发字符串脚本');
    if (command.includes('command -v rg')) {
      return Promise.resolve({ stdout: '', stderr: '', code: 1 });
    }
    // 有的 sshd 会把 SIGPIPE 设成忽略并被子进程继承,此时被 head 截断的 grep 会以 EPIPE 失败
    const script = options.ignoreSigpipe ? `trap '' PIPE; ${command}` : command;
    return new Promise((resolve, reject) => {
      const child = spawn('bash', ['-c', script]);
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
      child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
      child.on('error', reject);
      child.on('close', (code) =>
        resolve({
          stdout: Buffer.concat(stdout).toString('utf8'),
          stderr: Buffer.concat(stderr).toString('utf8'),
          code: code ?? 1,
        })
      );
      child.stdin.end();
    });
  };
  return {
    host: 'local-bash',
    exec: (command) => exec(command),
    async execRaw() {
      throw new Error('unused');
    },
    async execStream() {
      throw new Error('unused');
    },
  };
}

describe('远端 grep 真实管道', () => {
  let tmp: string;
  beforeEach(() => {
    tmp = mkdtempSync(path.join(os.tmpdir(), 'enso-remote-grep-'));
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  /** 输出远超管道缓冲区,保证 head 退出后 grep 还在写 */
  function writeManyMatches() {
    const lines = Array.from({ length: 20_000 }, (_, i) => `match ${i}`).join('\n');
    writeFileSync(path.join(tmp, 'big.txt'), `${lines}\n`);
  }

  // 真实场景:模型把正则写错,远端却回 "No matches found",被当成符号不存在
  it('正则写错时报错并带上 grep 的 stderr，而不是返回无命中', async () => {
    writeFileSync(path.join(tmp, 'a.ts'), 'const value = 1;\n');
    const tool = createRemoteGrepToolDefinition(tmp, localBashExecutor());
    await expect(tool.execute('t1', { pattern: '(' }, undefined, undefined, ctx)).rejects.toThrow(
      /grep:/
    );
  });

  // 真实场景:path 写错(目录不存在)同样被伪装成无命中
  it('搜索路径不存在时报错，而不是返回无命中', async () => {
    const tool = createRemoteGrepToolDefinition(tmp, localBashExecutor());
    await expect(
      tool.execute('t1', { pattern: 'value', path: 'missing-dir' }, undefined, undefined, ctx)
    ).rejects.toThrow(/missing-dir/);
  });

  it('命中超过 limit 被 head 截断时正常返回前 limit 行', async () => {
    writeManyMatches();
    const tool = createRemoteGrepToolDefinition(tmp, localBashExecutor());
    const result = await tool.execute(
      't1',
      { pattern: 'match', limit: 5 },
      undefined,
      undefined,
      ctx
    );
    const text = (result.content[0] as { text: string }).text;
    expect(text.split('\n')).toHaveLength(5);
  });

  it('远端忽略 SIGPIPE 时 grep 被截断后以 EPIPE 失败，仍按正常截断返回', async () => {
    writeManyMatches();
    const tool = createRemoteGrepToolDefinition(tmp, localBashExecutor({ ignoreSigpipe: true }));
    const result = await tool.execute(
      't1',
      { pattern: 'match', limit: 5 },
      undefined,
      undefined,
      ctx
    );
    const text = (result.content[0] as { text: string }).text;
    expect(text.split('\n')).toHaveLength(5);
  });

  it('有文件不可读但其余文件已命中时仍返回命中', async () => {
    writeFileSync(path.join(tmp, 'ok.txt'), 'token-hit\n');
    const locked = path.join(tmp, 'locked');
    mkdirSync(locked);
    writeFileSync(path.join(locked, 'hidden.txt'), 'token-hit\n');
    chmodSync(locked, 0o000);
    try {
      const tool = createRemoteGrepToolDefinition(tmp, localBashExecutor());
      const result = await tool.execute('t1', { pattern: 'token-hit' }, undefined, undefined, ctx);
      const text = (result.content[0] as { text: string }).text;
      expect(text).toContain('token-hit');
      expect(text).toContain('ok.txt');
    } finally {
      chmodSync(locked, 0o755);
    }
  });
});
