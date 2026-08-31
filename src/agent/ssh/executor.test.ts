import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { createSshExecutor, type SpawnLike } from './executor';

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
  const executor = createSshExecutor('user@dev-box', '/tmp/ctl', spawnImpl);
  return { procs, executor };
}

describe('SshExecutor', () => {
  it('argv 模式:spawn ssh 带 ControlPath,收集 stdout/stderr/code', async () => {
    const { procs, executor } = setup();
    const pending = executor.exec(['ls', '-la'], { cwd: '/srv/app' });
    const { args, proc } = procs[0];
    expect(args.join(' ')).toContain('ControlPath=/tmp/ctl/%C');
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

  it('code 255(ssh 自身失败)保留 stderr 供上层归因', async () => {
    const { procs, executor } = setup();
    const pending = executor.exec(['ls']);
    const { proc } = procs[0];
    proc.stderr.emit('data', Buffer.from('Permission denied (publickey)'));
    proc.emit('close', 255);
    await expect(pending).resolves.toMatchObject({ code: 255, stderr: /Permission denied/ });
  });
});
