/**
 * worker 内的 SSH 执行器:系统 ssh 子进程 + ControlMaster 连接复用。
 * 每个远程会话持有一个实例;ControlPath 按 host 哈希(%C)落在 controlDir,
 * 同 host 多会话自然共享一条真连接,worker 退出后 ControlPersist 到期自动断。
 */

import { type ChildProcess, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { buildRemoteCommand, buildSshExecArgs } from '@shared/ssh';

export interface SshExecResult {
  stdout: string;
  stderr: string;
  code: number;
}

export interface SshExecRawResult {
  stdout: Buffer;
  stderr: string;
  code: number;
}

export interface SshExecOptions {
  /** 写入远端命令 stdin 后关闭(write 工具传文件内容用) */
  stdin?: string | Buffer;
  timeoutMs?: number;
  signal?: AbortSignal;
  /** 远端工作目录 */
  cwd?: string;
}

export interface SshStreamOptions {
  onData: (chunk: Buffer) => void;
  signal?: AbortSignal;
  timeoutMs?: number;
  cwd?: string;
}

export type SpawnLike = (command: string, args: readonly string[]) => ChildProcess;

export interface SshExecutor {
  readonly host: string;
  /** argv 数组 = 精确参数;字符串 = 远端 bash -lc 脚本 */
  exec(command: string[] | string, options?: SshExecOptions): Promise<SshExecResult>;
  execRaw(command: string[] | string, options?: SshExecOptions): Promise<SshExecRawResult>;
  /** 流式执行(bash 工具用)：stdout/stderr 合流回调；中止/超时时 exitCode=null,对齐 BashOperations */
  execStream(
    command: string[] | string,
    options: SshStreamOptions
  ): Promise<{ exitCode: number | null }>;
}

/**
 * Darwin AF_UNIX 路径上限 104 字节;%C 展开约 40 字节。
 * userData/agent/ssh/%C 在 macOS 上会直接超限导致全部 ssh 失败,
 * 所以 socket 落 /tmp/ec-ssh/<controlDir 8 位哈希>/%C(同 agentDir 复用同一条 multiplex)。
 */
export function resolveSshControlPath(controlDir: string): string {
  const digest = createHash('sha1').update(controlDir).digest('hex').slice(0, 8);
  const dir = `/tmp/ec-ssh/${digest}`;
  mkdirSync(dir, { recursive: true });
  return `${dir}/%C`;
}

export function createSshExecutor(
  host: string,
  controlDir: string,
  spawnImpl: SpawnLike = spawn
): SshExecutor {
  const controlPath = resolveSshControlPath(controlDir);

  function run(command: string[] | string, options: SshExecOptions): Promise<SshExecRawResult> {
    return new Promise((resolve, reject) => {
      const remoteCommand = buildRemoteCommand(command, { cwd: options.cwd });
      const args = buildSshExecArgs(host, remoteCommand, { controlPath });
      const proc = spawnImpl('ssh', args);
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;

      const fail = (error: Error) => {
        if (settled) return;
        settled = true;
        cleanup();
        proc.kill('SIGTERM');
        reject(error);
      };
      const cleanup = () => {
        if (timer) clearTimeout(timer);
        options.signal?.removeEventListener('abort', onAbort);
      };
      const onAbort = () => fail(new Error('ssh command aborted'));

      if (options.timeoutMs !== undefined) {
        timer = setTimeout(
          () => fail(new Error(`ssh command timed out after ${options.timeoutMs}ms`)),
          options.timeoutMs
        );
      }
      if (options.signal) {
        if (options.signal.aborted) return onAbort();
        options.signal.addEventListener('abort', onAbort, { once: true });
      }

      proc.stdout?.on('data', (chunk: Buffer) => stdout.push(chunk));
      proc.stderr?.on('data', (chunk: Buffer) => stderr.push(chunk));
      proc.on('error', (error) => fail(new Error(`failed to spawn ssh: ${error.message}`)));
      proc.on('close', (code) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve({
          stdout: Buffer.concat(stdout),
          stderr: Buffer.concat(stderr).toString('utf8'),
          code: code ?? -1,
        });
      });

      if (options.stdin !== undefined && proc.stdin) {
        proc.stdin.write(options.stdin);
        proc.stdin.end();
      } else {
        proc.stdin?.end();
      }
    });
  }

  function stream(
    command: string[] | string,
    options: SshStreamOptions
  ): Promise<{ exitCode: number | null }> {
    return new Promise((resolve, reject) => {
      const remoteCommand = buildRemoteCommand(command, { cwd: options.cwd });
      const proc = spawnImpl('ssh', buildSshExecArgs(host, remoteCommand, { controlPath }));
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const finish = (exitCode: number | null) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        options.signal?.removeEventListener('abort', onAbort);
        resolve({ exitCode });
      };
      const onAbort = () => {
        proc.kill('SIGTERM');
        finish(null);
      };
      if (options.timeoutMs !== undefined) {
        timer = setTimeout(onAbort, options.timeoutMs);
      }
      if (options.signal) {
        if (options.signal.aborted) return onAbort();
        options.signal.addEventListener('abort', onAbort, { once: true });
      }
      proc.stdout?.on('data', (chunk: Buffer) => options.onData(chunk));
      proc.stderr?.on('data', (chunk: Buffer) => options.onData(chunk));
      proc.on('error', (error) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        options.signal?.removeEventListener('abort', onAbort);
        reject(new Error(`failed to spawn ssh: ${error.message}`));
      });
      proc.on('close', (code) => finish(code));
      proc.stdin?.end();
    });
  }

  return {
    host,
    async exec(command, options = {}) {
      const result = await run(command, options);
      return { ...result, stdout: result.stdout.toString('utf8') };
    },
    execRaw: (command, options = {}) => run(command, options),
    execStream: stream,
  };
}
