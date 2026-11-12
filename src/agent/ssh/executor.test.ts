import { type ChildProcess, spawn } from 'node:child_process';
import { EventEmitter, once } from 'node:events';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  createSshExecutor,
  resolveSshControlPath,
  type SpawnLike,
  sshPasswordEnv,
  writeSshAskpassHelper,
} from './executor';

class FakeProc extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  stdin = {
    written: [] as unknown[],
    ended: false,
    write(d: unknown) {
      this.written.push(d);
    },
    end() {
      this.ended = true;
    },
    // 真实 stdin 是 Writable;执行器会挂 error 监听
    on() {
      return this;
    },
  };
  killed = false;
  kill = vi.fn(() => {
    this.killed = true;
    queueMicrotask(() => this.emit('close', null, 'SIGTERM'));
    return true;
  });
}

function setup() {
  const procs: { args: string[]; proc: FakeProc }[] = [];
  const spawnImpl: SpawnLike = (_cmd, args) => {
    const proc = new FakeProc();
    procs.push({ args: args as string[], proc });
    return proc as never;
  };
  const executor = createSshExecutor(
    'user@dev-box',
    '/tmp/ctl',
    spawnImpl,
    { auth: 'key' },
    'darwin'
  );
  return { procs, executor };
}

describe('resolveSshControlPath', () => {
  it('压到 /tmp/ec-ssh/<8位哈希>/%C,展开后仍低于 Darwin 104 字节上限', () => {
    const long = '/Users/j3n5en/Library/Application Support/enso-code/agent/pi-agent/ssh';
    const resolved = resolveSshControlPath(long, 'darwin');
    expect(resolved).toMatch(/^\/tmp\/ec-ssh\/[0-9a-f]{8}\/%C$/);
    expect(resolved?.replace('%C', '0'.repeat(40)).length).toBeLessThan(104);
    expect(resolveSshControlPath(long, 'darwin')).toBe(resolved);
  });

  it('Windows 不启用 ControlMaster 套接字复用', () => {
    expect(resolveSshControlPath('C:\\Users\\app\\ssh', 'win32')).toBeUndefined();
  });
});

describe('SshExecutor', () => {
  it('argv 模式:spawn ssh 带 ControlPath,收集 stdout/stderr/code', async () => {
    const { procs, executor } = setup();
    const pending = executor.exec(['ls', '-la'], { cwd: '/srv/app' });
    const { args, proc } = procs[0];
    expect(args.join(' ')).toContain(`ControlPath=${resolveSshControlPath('/tmp/ctl', 'darwin')}`);
    expect(args[args.length - 2]).toBe('user@dev-box');
    expect(args[args.length - 1]).toBe("cd '/srv/app' && 'ls' '-la'");
    proc.stdout.emit('data', Buffer.from('file1\n'));
    proc.stderr.emit('data', Buffer.from('warn\n'));
    proc.emit('close', 0);
    await expect(pending).resolves.toEqual({ stdout: 'file1\n', stderr: 'warn\n', code: 0 });
  });

  it('stdin 写入并关闭;Buffer 二进制透传', async () => {
    const { procs, executor } = setup();
    const payload = Buffer.from([0, 1, 2, 255]);
    const pending = executor.exec('cat > /srv/x.bin', { stdin: payload });
    const { proc } = procs[0];
    expect(proc.stdin.written[0]).toBe(payload);
    expect(proc.stdin.ended).toBe(true);
    proc.emit('close', 0);
    await pending;
  });

  it('execRaw 返回 Buffer stdout(字节安全)', async () => {
    const { procs, executor } = setup();
    const pending = executor.execRaw(['cat', '/srv/x.bin']);
    const { proc } = procs[0];
    const bytes = Buffer.from([0xff, 0x00, 0x80]);
    proc.stdout.emit('data', bytes);
    proc.emit('close', 0);
    const result = await pending;
    expect(Buffer.compare(result.stdout, bytes)).toBe(0);
  });

  it('timeout 杀进程并 reject', async () => {
    vi.useFakeTimers();
    try {
      const { procs, executor } = setup();
      const pending = executor.exec(['sleep', '100'], { timeoutMs: 1000 });
      const rejection = expect(pending).rejects.toThrow(/timed out/i);
      await vi.advanceTimersByTimeAsync(1001);
      expect(procs[0].proc.kill).toHaveBeenCalled();
      await rejection;
    } finally {
      vi.useRealTimers();
    }
  });

  it('AbortSignal 中止杀进程并 reject', async () => {
    const { procs, executor } = setup();
    const controller = new AbortController();
    const pending = executor.exec(['sleep', '100'], { signal: controller.signal });
    const rejection = expect(pending).rejects.toThrow(/abort/i);
    controller.abort();
    expect(procs[0].proc.kill).toHaveBeenCalled();
    await rejection;
  });

  it('execStream:stdout/stderr 合流逐块回调,返回 exitCode', async () => {
    const { procs, executor } = setup();
    const chunks: string[] = [];
    const pending = executor.execStream('make build', {
      cwd: '/srv/app',
      onData: (d) => chunks.push(d.toString()),
    });
    const { args, proc } = procs[0];
    expect(args[args.length - 1]).toBe("cd '/srv/app' && bash -lc 'make build'");
    proc.stdout.emit('data', Buffer.from('out1'));
    proc.stderr.emit('data', Buffer.from('err1'));
    proc.stdout.emit('data', Buffer.from('out2'));
    proc.emit('close', 2);
    await expect(pending).resolves.toEqual({ exitCode: 2 });
    expect(chunks).toEqual(['out1', 'err1', 'out2']);
  });

  it('execStream 被信号中止时 exitCode 为 null(对齐 BashOperations 契约)', async () => {
    const { procs, executor } = setup();
    const controller = new AbortController();
    const pending = executor.execStream('sleep 100', {
      onData: () => {},
      signal: controller.signal,
    });
    controller.abort();
    expect(procs[0].proc.kill).toHaveBeenCalled();
    await expect(pending).resolves.toEqual({ exitCode: null });
  });

  it('Windows 下 spawn ssh 不含 ControlMaster/ControlPath', async () => {
    const procs: { args: string[]; proc: FakeProc }[] = [];
    const spawnImpl: SpawnLike = (_cmd, args) => {
      const proc = new FakeProc();
      procs.push({ args: args as string[], proc });
      return proc as never;
    };
    const executor = createSshExecutor(
      'user@dev-box',
      '/tmp/ctl',
      spawnImpl,
      { auth: 'key' },
      'win32'
    );
    const pending = executor.exec(['ls']);
    const joined = procs[0].args.join(' ');
    expect(joined).not.toContain('ControlMaster');
    expect(joined).not.toContain('ControlPath=');
    procs[0].proc.emit('close', 0);
    await pending;
  });

  it('code 255(ssh 自身失败)保留 stderr 供上层归因', async () => {
    const { procs, executor } = setup();
    const pending = executor.exec(['ls']);
    const { proc } = procs[0];
    proc.stderr.emit('data', Buffer.from('Permission denied (publickey)'));
    proc.emit('close', 255);
    await expect(pending).resolves.toMatchObject({ code: 255, stderr: /Permission denied/ });
  });
});

/** 收集测试窗口内的未捕获异常用于断言;EPIPE 由管道 IO 回调异步抛出,结束后多等一会儿让它冒出来 */
async function collectUncaught<T>(
  run: () => Promise<T>
): Promise<{ value: T; uncaught: unknown[] }> {
  const uncaught: unknown[] = [];
  process.setUncaughtExceptionCaptureCallback((error) => uncaught.push(error));
  try {
    const value = await run();
    await new Promise((resolve) => setTimeout(resolve, 100));
    return { value, uncaught };
  } finally {
    process.setUncaughtExceptionCaptureCallback(null);
  }
}

describe('SshExecutor 真实子进程 stdin', () => {
  // 超过管道缓冲区(约 64KB)才会有写不进去的尾巴,8KB 不复现
  const bigPayload = Buffer.alloc(1024 * 1024, 0x61);

  /** 用 node 子进程冒充 ssh:保留真实 stdin 管道,行为由脚本决定 */
  function realExecutor(script: string) {
    const children: ChildProcess[] = [];
    const spawnImpl: SpawnLike = () => {
      const child = spawn(process.execPath, ['-e', script]);
      children.push(child);
      return child;
    };
    const executor = createSshExecutor(
      'user@dev-box',
      '/tmp/ctl',
      spawnImpl,
      { auth: 'key' },
      'darwin'
    );
    return { children, executor };
  }

  // 真实场景:write 大文件时 ssh 建连失败(exit 255)早于读完 stdin,写管道 EPIPE 无人监听会让 worker 直接崩溃
  it('ssh 没读完大块 stdin 就退出时返回失败结果，不抛出未捕获的 EPIPE', async () => {
    const { executor } = realExecutor('process.exit(255)');
    const { value, uncaught } = await collectUncaught(() =>
      executor.exec('cat > /srv/big.bin', { stdin: bigPayload })
    );
    expect(value.code).toBe(255);
    expect(uncaught).toEqual([]);
  });

  // 真实场景:用户停止 / 30 秒超时都会走 kill,被杀的 ssh 同样来不及读完 stdin
  it('写大块 stdin 途中被中止时只 reject 中止错误，不抛出未捕获的 EPIPE', async () => {
    const { children, executor } = realExecutor('setTimeout(() => {}, 30_000)');
    const controller = new AbortController();
    const { value, uncaught } = await collectUncaught(async () => {
      const pending = executor.exec('cat > /srv/big.bin', {
        stdin: bigPayload,
        signal: controller.signal,
      });
      controller.abort();
      const outcome = await pending.catch((error: unknown) => error);
      if (children[0].exitCode === null && children[0].signalCode === null) {
        await once(children[0], 'close');
      }
      return outcome;
    });
    expect(value).toBeInstanceOf(Error);
    expect((value as Error).message).toMatch(/abort/i);
    expect(uncaught).toEqual([]);
  });
});

describe('sshPasswordEnv / writeSshAskpassHelper', () => {
  it('Unix 写可执行 askpass.sh，SSH_ASKPASS 指向脚本', () => {
    const dir = path.join(tmpdir(), `enso-askpass-unix-${Date.now()}`);
    const helper = writeSshAskpassHelper(dir, 'darwin');
    expect(helper.endsWith('askpass.sh')).toBe(true);
    expect(readFileSync(helper, 'utf8')).toContain('printf %s');
    const env = sshPasswordEnv(dir, 'secret', 'darwin');
    expect(env.SSH_ASKPASS).toBe(helper);
    expect(env.ENSO_SSH_ASKPASS_PASSWORD).toBe('secret');
    expect(env.SSH_ASKPASS_REQUIRE).toBe('force');
  });

  it('Windows 不把 .sh 交给 CreateProcess，改用 node --require', () => {
    const dir = path.join(tmpdir(), `enso-askpass-win-${Date.now()}`);
    const helper = writeSshAskpassHelper(dir, 'win32');
    expect(helper.endsWith('askpass.cjs')).toBe(true);
    expect(readFileSync(helper, 'utf8')).toContain('ENSO_SSH_ASKPASS_PASSWORD');
    const env = sshPasswordEnv(dir, 'secret', 'win32');
    expect(env.SSH_ASKPASS).toBe(process.execPath);
    expect(env.ELECTRON_RUN_AS_NODE).toBe('1');
    expect(env.NODE_OPTIONS).toContain('askpass.cjs');
    expect(env.SSH_ASKPASS).not.toMatch(/\.sh$/);
  });
});
