import { execFileSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  rmSync,
  statSync,
  truncateSync,
  writeFileSync,
} from 'node:fs';
import { access } from 'node:fs/promises';
import { constants as osConstants } from 'node:os';
import path from 'node:path';
import { type BashOperations, getShellConfig } from '@earendil-works/pi-coding-agent';

/**
 * 能活过 worker 的命令进程（本地 POSIX）：detached 独立会话，stdin 关闭，stdout/stderr 直写
 * task-logs 下的输出文件（不经管道，worker 退出不会让它 SIGPIPE），退出码由 shell 的 EXIT trap
 * 写进同目录的退出码文件。worker 在世时轮询跟读输出文件；重启前停止跟读、记下读到的偏移，
 * 新 worker 按偏移接着读。runId 写在 shell 命令行里（退出码文件路径）和进程环境变量里，连同进程启动时间
 * 用来认出 pid 是不是还是它（命令 exec 换掉 shell 后命令行里就没有 runId 了）。
 */
export interface DetachedRunFiles {
  runId: string;
  pid: number;
  startedAt: number;
  cwd: string;
  outputFile: string;
  exitFile: string;
}

export interface FileBackedRun extends DetachedRunFiles {
  /** 输出接收者（可多次替换）；release 之后不再回调 */
  sink(onData: (chunk: Buffer) => void): void;
  /** 立即把文件里已有的新输出读给接收者（让位回执取输出前调用） */
  flush(): void;
  /** 读输出文件失败的原因；读得到时为 null */
  readError(): string | null;
  /** worker 看到进程结束、输出读完；release 之后永不落定 */
  readonly done: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  kill(signal: NodeJS.Signals): void;
  /** 交出进程：读完已有输出后停止跟读，进程不动；返回输出文件已读字节数 */
  release(): number;
}

export interface RunProbe {
  alive(pid: number): boolean;
  /** pid 现在还是不是这次起的那个进程：防 pid 被别的进程复用 */
  matches(pid: number, run: RunIdentity): boolean;
}

/** 认 pid 用的标记：runId，和进程实际启动的时刻（ms） */
export interface RunIdentity {
  runId: string;
  startedAt: number;
}

/** 起进程时放进环境变量的 runId：exec 换掉 shell 后仍在（Linux 从 /proc/<pid>/environ 读回）。不是密钥 */
export const RUN_ID_ENV = 'ENSO_RUN_ID';
/** 进程启动时间与登记时刻的容差：ps 的 etime 只到秒，登记时刻在 spawn 返回之后 */
const START_TOLERANCE_MS = 3_000;
const RUN_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** 跟读间隔：有新输出时最快，空闲时逐步放慢到上限（退出由 exit 事件即时感知，不靠轮询） */
const LIVE_POLL_MIN_MS = 15;
const LIVE_POLL_MAX_MS = 250;
const ATTACH_POLL_MS = 250;
/** 认回的进程每隔这么多轮核对一次命令行（macOS 要起 ps），其余轮只探存活与退出码文件 */
const IDENTITY_EVERY = 40;
const READ_CHUNK = 64 * 1024;
/**
 * 原始输出文件读到这么大且已读到末尾时清零重来（子进程以 O_APPEND 写，清零后接着从头写）：
 * 长期跑的 dev server 不让它无限增长。清零前后极短窗口内写入的字节可能丢，全量回看以任务日志为准。
 */
const TRUNCATE_AT = 8 * 1024 * 1024;

export function isRunId(value: unknown): value is string {
  return typeof value === 'string' && RUN_ID.test(value);
}

export function runFiles(
  dir: string,
  runId: string
): { outputFile: string; exitFile: string; metaFile: string } {
  return {
    outputFile: path.join(dir, `run-${runId}.out`),
    exitFile: path.join(dir, `run-${runId}.exit`),
    metaFile: path.join(dir, `run-${runId}.json`),
  };
}

export function removeRunFiles(dir: string, runId: string): void {
  for (const file of Object.values(runFiles(dir, runId))) rmSync(file, { force: true });
}

/** POSIX shell 单引号转义 */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** 同一行前置 EXIT trap：不改原命令的行号；用户命令自己设 EXIT trap 会覆盖它，退出码就只能从 worker 拿 */
export function withExitTrap(command: string, exitFile: string): string {
  return `trap ${shellQuote(`printf %s "$?" > ${shellQuote(exitFile)}`)} EXIT; ${command}`;
}

export function readExitCode(file: string): number | null {
  try {
    const text = readFileSync(file, 'utf8').trim();
    return /^\d{1,3}$/.test(text) ? Number(text) : null;
  } catch {
    return null;
  }
}

/** 信号 0 只探测存活。pid 0 会打到进程组，不当成活着 */
export function processAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

/** 只读这一个 pid 的命令行，不扫进程表；读不到返回 null */
export function processCommandLine(pid: number): string | null {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    if (process.platform === 'linux') {
      return readFileSync(`/proc/${pid}/cmdline`, 'utf8').replace(/\0/g, ' ');
    }
    return execFileSync(
      existsSync('/bin/ps') ? '/bin/ps' : 'ps',
      ['-ww', '-o', 'command=', '-p', String(pid)],
      {
        encoding: 'utf8',
        timeout: 2_000,
        stdio: ['ignore', 'pipe', 'ignore'],
      }
    );
  } catch {
    return null;
  }
}

/** ps 的 etime（[[dd-]hh:]mm:ss）换成毫秒；格式不对返回 null */
export function parseElapsed(text: string): number | null {
  const match = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/.exec(text.trim());
  if (!match) return null;
  const [, days, hours, minutes, seconds] = match;
  return (
    (((Number(days ?? 0) * 24 + Number(hours ?? 0)) * 60 + Number(minutes)) * 60 +
      Number(seconds)) *
    1000
  );
}

/** pid 的启动时刻（ms）；exec 不改变它，pid 被复用的进程一定更晚启动。读不到返回 null */
export function processStartedAt(pid: number): number | null {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    const elapsed = parseElapsed(
      execFileSync(existsSync('/bin/ps') ? '/bin/ps' : 'ps', ['-o', 'etime=', '-p', String(pid)], {
        encoding: 'utf8',
        timeout: 2_000,
        stdio: ['ignore', 'pipe', 'ignore'],
      })
    );
    return elapsed === null ? null : Date.now() - elapsed;
  } catch {
    return null;
  }
}

function environHas(pid: number, entry: string): boolean {
  try {
    return readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0').includes(entry);
  } catch {
    return false;
  }
}

/**
 * 命令行带着 runId（shell 还在）；或 Linux 上进程环境里带着它；或进程启动时间对得上登记时刻
 * （macOS 读不到别的进程的环境变量）。三者都对不上就当 pid 已被复用
 */
export function runIdentityMatches(pid: number, run: RunIdentity): boolean {
  if (processCommandLine(pid)?.includes(run.runId)) return true;
  if (process.platform === 'linux' && environHas(pid, `${RUN_ID_ENV}=${run.runId}`)) return true;
  const startedAt = processStartedAt(pid);
  return startedAt !== null && Math.abs(startedAt - run.startedAt) <= START_TOLERANCE_MS;
}

export const defaultRunProbe: RunProbe = {
  alive: processAlive,
  matches: runIdentityMatches,
};

/** 杀整个进程组；macOS 先 SIGSTOP 再 SIGKILL，与 pi 前台中止一致（防 `a; b` 在取消时起 b） */
export function killRunGroup(pid: number, signal: NodeJS.Signals): void {
  if (process.platform === 'darwin' && signal === 'SIGKILL') {
    try {
      process.kill(-pid, 'SIGSTOP');
    } catch {}
  }
  try {
    process.kill(-pid, signal);
  } catch {
    try {
      process.kill(pid, signal);
    } catch {}
  }
}

/** 从 offset 起跟读输出文件；文件不在时只是读不到 */
class FileTail {
  private fd: number | null = null;
  private onData: (chunk: Buffer) => void = () => {};
  error: string | null = null;

  constructor(
    private readonly file: string,
    public offset: number
  ) {
    try {
      this.fd = openSync(file, 'r');
      if (statSync(file).size < offset) this.offset = 0;
    } catch (error) {
      this.fd = null;
      this.error = errorMessage(error);
    }
  }

  sink(onData: (chunk: Buffer) => void): void {
    this.onData = onData;
  }

  /** 读到末尾；返回这次有没有读到新输出 */
  drain(): boolean {
    if (this.fd === null) return false;
    const buffer = Buffer.allocUnsafe(READ_CHUNK);
    let any = false;
    for (;;) {
      let read: number;
      try {
        read = readSync(this.fd, buffer, 0, READ_CHUNK, this.offset);
      } catch (error) {
        this.error = errorMessage(error);
        return any;
      }
      this.error = null;
      if (read <= 0) break;
      any = true;
      this.offset += read;
      this.onData(Buffer.from(buffer.subarray(0, read)));
    }
    if (this.offset >= TRUNCATE_AT) {
      try {
        truncateSync(this.file, 0);
        this.offset = 0;
      } catch {}
    }
    return any;
  }

  close(): void {
    if (this.fd !== null) closeSync(this.fd);
    this.fd = null;
  }
}

const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));

function writeRunMeta(dir: string, run: DetachedRunFiles): void {
  try {
    writeFileSync(
      runFiles(dir, run.runId).metaFile,
      JSON.stringify({
        version: 1,
        runId: run.runId,
        ownerPid: process.pid,
        pid: run.pid,
        startedAt: run.startedAt,
      })
    );
  } catch {}
}

/** 起一个输出直写文件的 detached 进程；spawn 失败经 done reject */
export function spawnFileBacked(input: {
  shell: string;
  args: readonly string[];
  command: string;
  cwd: string;
  env?: NodeJS.ProcessEnv;
  dir: string;
}): FileBackedRun {
  mkdirSync(input.dir, { recursive: true });
  const runId = randomUUID();
  const { outputFile, exitFile } = runFiles(input.dir, runId);
  const out = openSync(outputFile, 'a');
  let child: ReturnType<typeof spawn>;
  try {
    child = spawn(input.shell, [...input.args, withExitTrap(input.command, exitFile)], {
      cwd: input.cwd,
      detached: true,
      env: { ...(input.env ?? process.env), [RUN_ID_ENV]: runId },
      stdio: ['ignore', out, out],
    });
  } finally {
    closeSync(out);
  }
  const files: DetachedRunFiles = {
    runId,
    pid: child.pid ?? -1,
    startedAt: Date.now(),
    cwd: input.cwd,
    outputFile,
    exitFile,
  };
  if (child.pid !== undefined) writeRunMeta(input.dir, files);
  const tail = new FileTail(outputFile, 0);
  let released = false;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const poll = (delay: number) => {
    timer = setTimeout(() => {
      if (stopped) return;
      poll(tail.drain() ? LIVE_POLL_MIN_MS : Math.min(LIVE_POLL_MAX_MS, delay * 2));
    }, delay);
    timer.unref?.();
  };
  poll(LIVE_POLL_MIN_MS);
  const finish = () => {
    stopped = true;
    clearTimeout(timer);
    tail.drain();
    tail.close();
    removeRunFiles(input.dir, runId);
  };
  const done = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolve, reject) => {
      child.once('error', (error) => {
        if (released) return;
        finish();
        reject(error);
      });
      child.once('exit', (code, signal) => {
        if (released) return;
        finish();
        resolve({ code, signal });
      });
    }
  );
  return {
    ...files,
    sink: (onData) => tail.sink(onData),
    flush: () => {
      if (!stopped) tail.drain();
    },
    readError: () => tail.error,
    done,
    kill: (signal) => {
      if (child.pid !== undefined) killRunGroup(child.pid, signal);
    },
    release: () => {
      if (!released) {
        released = true;
        stopped = true;
        clearTimeout(timer);
        tail.drain();
        tail.close();
        child.unref();
      }
      return tail.offset;
    },
  };
}

/**
 * 新 worker 认回上一代交出来的进程：按偏移接着读输出文件；退出码文件出现、pid 不在或
 * 命令行不再带 runId（pid 被复用）即视为结束，读完剩余输出、取退出码（拿不到为 null）。
 * kill 前再核对一次命令行，绝不向已被复用的 pid 发信号。
 */
export function attachFileBacked(
  dir: string,
  run: DetachedRunFiles,
  offset: number,
  probe: RunProbe = defaultRunProbe
): FileBackedRun {
  const tail = new FileTail(run.outputFile, offset);
  writeRunMeta(dir, run);
  let released = false;
  let ticks = 0;
  let timer: ReturnType<typeof setInterval> | undefined;
  let ended = false;
  const done = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    const check = () => {
      tail.drain();
      ticks += 1;
      ended =
        readExitCode(run.exitFile) !== null ||
        !probe.alive(run.pid) ||
        (ticks % IDENTITY_EVERY === 0 && !probe.matches(run.pid, run));
      if (!ended) return;
      clearInterval(timer);
      tail.drain();
      tail.close();
      const code = readExitCode(run.exitFile);
      removeRunFiles(dir, run.runId);
      resolve({ code, signal: null });
    };
    timer = setInterval(() => {
      if (!released) check();
    }, ATTACH_POLL_MS);
    timer.unref?.();
  });
  return {
    ...run,
    sink: (onData) => tail.sink(onData),
    flush: () => {
      if (!released && !ended) tail.drain();
    },
    readError: () => tail.error,
    done,
    kill: (signal) => {
      if (probe.matches(run.pid, run)) killRunGroup(run.pid, signal);
    },
    release: () => {
      if (!released) {
        released = true;
        clearInterval(timer);
        tail.drain();
        tail.close();
      }
      return tail.offset;
    },
  };
}

/** 一次性读出 offset 之后的输出（进程已不在时收尾用） */
export function readRunOutput(file: string, offset: number): Buffer {
  const chunks: Buffer[] = [];
  const tail = new FileTail(file, offset);
  tail.sink((chunk) => chunks.push(chunk));
  tail.drain();
  tail.close();
  return Buffer.concat(chunks);
}

/** 只读文件最后 max 字节：截断时丢掉被劈开的首行；整段没有换行就只跳过劈开的多字节字符。读不到返回空 */
export function readFileTail(file: string, max: number): Buffer {
  let fd: number | undefined;
  try {
    fd = openSync(file, 'r');
    const size = statSync(file).size;
    const length = Math.min(size, max);
    const buffer = Buffer.alloc(length);
    const read = readSync(fd, buffer, 0, length, size - length);
    const tail = buffer.subarray(0, read);
    if (length === size) return tail;
    const newline = tail.indexOf(0x0a);
    if (newline !== -1) return tail.subarray(newline + 1);
    let start = 0;
    while (start < tail.length && (tail[start] & 0xc0) === 0x80) start += 1;
    return tail.subarray(start);
  } catch {
    return Buffer.alloc(0);
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/**
 * worker 异常退出（崩溃、被强杀）没走交接时，它起的文件直写进程不会像管道进程那样随 SIGPIPE 退出。
 * 冷启动时按 task-logs 里的登记逐个检查：登记它的 worker 已不在、进程还在且认得出是本次起的进程，
 * 才杀它的进程组；其余一律不碰，只清掉已结束的登记文件。不扫系统进程表。
 */
export function sweepOrphanRuns(
  dir: string,
  keep: ReadonlySet<string>,
  probe: RunProbe = defaultRunProbe
): string[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const killed: string[] = [];
  for (const name of names) {
    const match = /^run-(.+)\.json$/.exec(name);
    const runId = match?.[1];
    if (!runId || !isRunId(runId) || keep.has(runId)) continue;
    let meta: { ownerPid?: unknown; pid?: unknown; startedAt?: unknown };
    try {
      meta = JSON.parse(readFileSync(path.join(dir, name), 'utf8')) as typeof meta;
    } catch {
      continue;
    }
    const ownerPid = typeof meta.ownerPid === 'number' ? meta.ownerPid : -1;
    const pid = typeof meta.pid === 'number' ? meta.pid : -1;
    const startedAt = typeof meta.startedAt === 'number' ? meta.startedAt : Number.NaN;
    if (ownerPid === process.pid || probe.alive(ownerPid)) continue;
    if (probe.alive(pid)) {
      if (!probe.matches(pid, { runId, startedAt })) {
        removeRunFiles(dir, runId);
        continue;
      }
      killRunGroup(pid, 'SIGKILL');
      killed.push(runId);
    }
    removeRunFiles(dir, runId);
  }
  return killed;
}

interface FileBackedRequest {
  dir: string;
  onSpawn(run: FileBackedRun): void;
}

const requests = new WeakMap<AbortSignal, FileBackedRequest>();

/** 前台命令登记：这次 exec 用文件直写方式起进程，并把句柄交回（转后台后重启时可脱离） */
export function requestFileBackedRun(signal: AbortSignal, request: FileBackedRequest): void {
  requests.set(signal, request);
}

/**
 * 包装本地 bash operations：登记过的前台调用改为文件直写输出的 detached 进程，语义与 pi 本地执行一致
 * （退出码、信号退出 128+n、中止杀进程组、cwd 不存在报错）；未登记、带 timeout、stdin 传命令的照旧走 pi。
 */
export function withFileBackedExec(
  inner: BashOperations,
  resolveShell: () => { shell: string; args: string[]; commandTransport?: 'argv' | 'stdin' } = () =>
    getShellConfig()
): BashOperations {
  return {
    async exec(command, cwd, options) {
      const request = options.signal ? requests.get(options.signal) : undefined;
      const shell = request ? resolveShell() : undefined;
      if (!request || !shell || shell.commandTransport === 'stdin' || options.timeout !== undefined)
        return inner.exec(command, cwd, options);
      const { onData, signal, env } = options;
      if (signal?.aborted) throw new Error('aborted');
      try {
        await access(cwd);
      } catch {
        throw new Error(`Working directory does not exist: ${cwd}\nCannot execute bash commands.`);
      }
      const run = spawnFileBacked({
        shell: shell.shell,
        args: shell.args,
        command,
        cwd,
        env,
        dir: request.dir,
      });
      run.sink(onData);
      request.onSpawn(run);
      const onAbort = () => run.kill('SIGKILL');
      signal?.addEventListener('abort', onAbort, { once: true });
      try {
        const result = await run.done;
        if (signal?.aborted) throw new Error('aborted');
        const exitCode =
          result.code ?? (result.signal ? 128 + (osConstants.signals[result.signal] ?? 0) : 1);
        return { exitCode };
      } finally {
        signal?.removeEventListener('abort', onAbort);
      }
    },
  };
}
