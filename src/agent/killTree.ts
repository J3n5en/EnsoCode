import { spawn as nodeSpawn } from 'node:child_process';
import path from 'node:path';

interface KillableChild {
  pid?: number;
  kill(signal?: NodeJS.Signals): boolean;
}

interface KillTreeDeps {
  platform?: NodeJS.Platform;
  systemRoot?: string;
  spawn?: (
    file: string,
    args: readonly string[],
    opts: { windowsHide: boolean; stdio: 'ignore' }
  ) => { on(event: 'error', listener: (error: Error) => void): unknown };
  killGroup?: (pid: number, signal: NodeJS.Signals) => void;
}

/**
 * 杀整棵进程树。POSIX：detached 子进程是独立进程组，向 -pid 发信号。
 * Windows 没有进程组，kill(-pid) 恒 ESRCH，只能 taskkill /T /F（无 SIGTERM 语义，一律强杀）；
 * 用 System32 绝对路径，不吃 PATH 里同名程序。
 */
export function killProcessTree(
  child: KillableChild,
  signal: NodeJS.Signals,
  deps: KillTreeDeps = {}
): void {
  const pid = child.pid;
  const platform = deps.platform ?? process.platform;
  const fallback = () => {
    try {
      child.kill(signal);
    } catch {}
  };
  if (pid === undefined) {
    fallback();
    return;
  }
  try {
    if (platform === 'win32') {
      const root = deps.systemRoot ?? process.env.SystemRoot ?? 'C:\\Windows';
      const spawn = deps.spawn ?? nodeSpawn;
      spawn(path.win32.join(root, 'System32', 'taskkill.exe'), ['/pid', String(pid), '/T', '/F'], {
        windowsHide: true,
        stdio: 'ignore',
      }).on('error', fallback);
      return;
    }
    if (deps.killGroup) deps.killGroup(-pid, signal);
    else process.kill(-pid, signal);
  } catch {
    fallback();
  }
}
