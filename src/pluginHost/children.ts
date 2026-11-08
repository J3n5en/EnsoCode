import type { ChildProcess } from 'node:child_process';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { promisify } from 'node:util';

/** 当前插件宿主要负责收掉的子进程；只在 runPluginHost 期间收集 */
let bucket: Set<ChildProcess> | null = null;
let hooked = false;

function track(child: ChildProcess): ChildProcess {
  const current = bucket;
  if (!current) return child;
  current.add(child);
  child.once('exit', () => current.delete(child));
  return child;
}

function attachStdioPromisify<T extends (...args: unknown[]) => ChildProcess>(fn: T): T {
  Object.defineProperty(fn, promisify.custom, {
    enumerable: false,
    value: (...args: unknown[]) => {
      let child: ChildProcess | undefined;
      const promise = new Promise<{ stdout: string | Buffer; stderr: string | Buffer }>(
        (resolve, reject) => {
          child = fn(
            ...args,
            (err: Error | null, stdout: string | Buffer, stderr: string | Buffer) => {
              if (err) {
                Object.assign(err, { stdout, stderr });
                reject(err);
              } else {
                resolve({ stdout, stderr });
              }
            }
          );
        }
      );
      if (child) Object.assign(promise, { child });
      return promise;
    },
  });
  return fn;
}

/** 替换 node:child_process，让插件拉起的子进程在 shutdown 时能被关掉 */
export function installChildProcessHooks(): void {
  if (hooked) return;
  hooked = true;
  const cp = createRequire(import.meta.url)(
    'node:child_process'
  ) as typeof import('node:child_process');
  const spawn = cp.spawn;
  const exec = cp.exec;
  const execFile = cp.execFile;
  const fork = cp.fork;
  cp.spawn = ((
    file: string,
    args?: readonly string[] | import('node:child_process').SpawnOptions,
    options?: import('node:child_process').SpawnOptions
  ) => {
    if (args === undefined) return track(spawn(file));
    if (Array.isArray(args)) {
      return track(
        options === undefined ? spawn(file, [...args]) : spawn(file, [...args], options)
      );
    }
    return track(spawn(file, args as import('node:child_process').SpawnOptions));
  }) as typeof cp.spawn;
  cp.exec = attachStdioPromisify(((command: string, options?: unknown, callback?: unknown) => {
    const child =
      typeof options === 'function'
        ? exec(command, options as never)
        : callback
          ? exec(command, options as never, callback as never)
          : options
            ? exec(command, options as never)
            : exec(command);
    return track(child);
  }) as unknown as (...args: unknown[]) => ChildProcess) as unknown as typeof cp.exec;
  cp.execFile = attachStdioPromisify(((
    file: string,
    args?: unknown,
    options?: unknown,
    callback?: unknown
  ) => {
    const child =
      typeof args === 'function'
        ? execFile(file, args as never)
        : typeof options === 'function'
          ? execFile(file, args as never, options as never)
          : callback
            ? execFile(file, args as never, options as never, callback as never)
            : options
              ? execFile(file, args as never, options as never)
              : args
                ? execFile(file, args as never)
                : execFile(file);
    return track(child);
  }) as unknown as (...args: unknown[]) => ChildProcess) as unknown as typeof cp.execFile;
  cp.fork = ((
    modulePath: string,
    args?: readonly string[],
    options?: import('node:child_process').ForkOptions
  ) =>
    track(
      args === undefined ? fork(modulePath) : fork(modulePath, [...args], options)
    )) as typeof cp.fork;
  try {
    syncBuiltinESMExports();
  } catch {
    // CJS 导出已替换；ESM 绑定同步失败时插件仍可能拿到原函数
  }
}

export function beginChildTracking(): void {
  bucket = new Set();
}

export function killTrackedChildren(): void {
  const current = bucket;
  bucket = null;
  if (!current) return;
  for (const child of current) {
    try {
      child.kill();
    } catch {
      // 已经退出
    }
  }
  current.clear();
}

/** 未捕获异常退出前先关掉插件拉起的子进程，避免留下孤儿进程 */
export function failHostProcess(
  error: unknown,
  report: (message: string) => void,
  exit: (code: number) => void
): void {
  const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
  killTrackedChildren();
  try {
    report(message);
  } catch {
    // 上报失败也不能跳过退出
  }
  exit(1);
}
