import { describe, expect, it } from 'vitest';
import type { SshExecOptions, SshExecutor, SshStreamOptions } from './executor';
import {
  buildRemoteFindScript,
  buildRemoteGrepScript,
  createRemoteOperations,
  detectImageMimeByExtension,
} from './remoteOperations';

interface Call {
  kind: 'exec' | 'execRaw' | 'execStream';
  command: string[] | string;
  options?: SshExecOptions | SshStreamOptions;
}

function fakeExecutor(respond: (call: Call) => { stdout?: string; code?: number } = () => ({})): {
  calls: Call[];
  executor: SshExecutor;
} {
  const calls: Call[] = [];
  const executor: SshExecutor = {
    host: 'h',
    async exec(command, options) {
      const call: Call = { kind: 'exec', command, options };
      calls.push(call);
      const r = respond(call);
      return { stdout: r.stdout ?? '', stderr: '', code: r.code ?? 0 };
    },
    async execRaw(command, options) {
      const call: Call = { kind: 'execRaw', command, options };
      calls.push(call);
      const r = respond(call);
      return { stdout: Buffer.from(r.stdout ?? ''), stderr: '', code: r.code ?? 0 };
    },
    async execStream(command, options) {
      calls.push({ kind: 'execStream', command, options });
      options.onData(Buffer.from('output'));
      return { exitCode: 0 };
    },
  };
  return { calls, executor };
}

describe('read/edit/write operations', () => {
  it('readFile 走 execRaw cat(字节安全);access 用 test -r,失败抛错', async () => {
    const { calls, executor } = fakeExecutor((call) =>
      Array.isArray(call.command) && call.command[0] === 'test' ? { code: 1 } : { stdout: 'data' }
    );
    const ops = createRemoteOperations(executor);
    const buf = await ops.read.readFile('/srv/a.txt');
    expect(buf.toString()).toBe('data');
    expect(calls[0]).toMatchObject({ kind: 'execRaw', command: ['cat', '--', '/srv/a.txt'] });
    await expect(ops.read.access('/srv/a.txt')).rejects.toThrow(/not readable|denied/i);
  });

  it('writeFile:先 mkdir -p 父目录,内容经 stdin 写入(不经参数转义)', async () => {
    const { calls, executor } = fakeExecutor();
    const ops = createRemoteOperations(executor);
    await ops.write.writeFile('/srv/dir/b.txt', "content with 'quotes'\n\0bin");
    const write = calls.find((c) => typeof c.command === 'string' && c.command.includes('cat >'));
    if (!write) throw new Error('未找到写入调用');
    expect(write.command).toBe("cat > '/srv/dir/b.txt'");
    expect((write.options as SshExecOptions).stdin?.toString()).toBe(
      "content with 'quotes'\n\0bin"
    );
  });

  it('edit ops 的 access 校验读写权限', async () => {
    const { calls, executor } = fakeExecutor();
    const ops = createRemoteOperations(executor);
    await ops.edit.access('/srv/a.txt');
    expect(calls[0].command).toEqual(['test', '-r', '/srv/a.txt', '-a', '-w', '/srv/a.txt']);
  });
});

describe('ls operations', () => {
  it('exists/stat/readdir 映射;stat 对不存在路径抛错', async () => {
    const { executor } = fakeExecutor((call) => {
      const cmd = call.command;
      if (typeof cmd === 'string' && cmd.includes('__MISSING__')) return { code: 2 };
      if (typeof cmd === 'string') return { stdout: 'd' };
      return { stdout: '.\n..\nsrc\nfile.txt\n' };
    });
    const ops = createRemoteOperations(executor);
    const stat = await ops.ls.stat('/srv');
    expect(stat.isDirectory()).toBe(true);
    await expect(ops.ls.stat('/srv/__MISSING__')).rejects.toThrow();
    const entries = await ops.ls.readdir('/srv');
    expect(entries).toEqual(['src', 'file.txt']);
  });
});

describe('bash operations', () => {
  it('exec 走 execStream:脚本 + cwd + timeout 透传', async () => {
    const { calls, executor } = fakeExecutor();
    const ops = createRemoteOperations(executor);
    const chunks: string[] = [];
    const result = await ops.bash.exec('make build', '/srv/app', {
      onData: (d) => chunks.push(d.toString()),
      timeout: 5, // BashOperations 契约:秒
    });
    expect(result.exitCode).toBe(0);
    expect(chunks).toEqual(['output']);
    expect(calls[0]).toMatchObject({ kind: 'execStream', command: 'make build' });
    expect((calls[0].options as SshStreamOptions).cwd).toBe('/srv/app');
    expect((calls[0].options as SshStreamOptions).timeoutMs).toBe(5000);
  });
});

describe('buildRemoteFindScript', () => {
  it('裸文件名 glob 用 -name;剪枝 ignore 目录;head 限量', () => {
    const script = buildRemoteFindScript('*.ts', '/srv/app', {
      ignore: ['node_modules', '.git'],
      limit: 100,
    });
    expect(script).toContain("find '/srv/app'");
    expect(script).toContain("-name 'node_modules' -prune");
    expect(script).toContain("-name '.git' -prune");
    expect(script).toContain("-name '*.ts'");
    expect(script).toContain('head -n 100');
  });

  it('带路径的 glob 用 -path,** 折叠为 *', () => {
    const script = buildRemoteFindScript('src/**/*.spec.ts', '/srv/app', { ignore: [], limit: 10 });
    expect(script).toContain("-path '/srv/app/src/*.spec.ts'");
  });
});

describe('buildRemoteGrepScript', () => {
  it('rg 引擎:参数完整映射', () => {
    const script = buildRemoteGrepScript(
      { pattern: 'foo.*bar', path: 'src', glob: '*.ts', ignoreCase: true, context: 2, limit: 50 },
      '/srv/app',
      'rg'
    );
    expect(script).toContain('rg -n --no-heading --color never');
    expect(script).toContain('-i');
    expect(script).toContain('-C 2');
    expect(script).toContain("--glob '*.ts'");
    expect(script).toContain("'foo.*bar'");
    expect(script).toContain("'/srv/app/src'");
    expect(script).toContain('head -n');
  });

  it('grep 引擎降级:literal 用 -F,glob 映射 --include', () => {
    const script = buildRemoteGrepScript(
      { pattern: 'a+b', literal: true, glob: '*.py' },
      '/srv/app',
      'grep'
    );
    expect(script).toContain('grep -rn');
    expect(script).toContain('-F');
    expect(script).toContain("--include='*.py'");
    expect(script).toContain("'a+b'");
    expect(script).toContain("'/srv/app'");
  });
});

describe('detectImageMimeByExtension', () => {
  it('常见图片扩展名映射,非图片返回 null', () => {
    expect(detectImageMimeByExtension('/a/b.PNG')).toBe('image/png');
    expect(detectImageMimeByExtension('/a/b.jpg')).toBe('image/jpeg');
    expect(detectImageMimeByExtension('/a/b.webp')).toBe('image/webp');
    expect(detectImageMimeByExtension('/a/b.ts')).toBeNull();
  });
});
