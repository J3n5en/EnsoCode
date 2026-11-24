import { execFileSync, spawn as nodeSpawn } from 'node:child_process';
import path from 'node:path';

interface KillableChild {
  pid?: number;
  kill(signal?: NodeJS.Signals): boolean;
}

export interface ProcessEntry {
  pid: number;
  ppid: number;
  pgid: number;
}

interface TreeDeps {
  platform?: NodeJS.Platform;
  listProcesses?: () => ProcessEntry[];
  killGroup?: (pid: number, signal: NodeJS.Signals) => void;
}

interface KillTreeDeps extends TreeDeps {
  systemRoot?: string;
  spawn?: (
    file: string,
    args: readonly string[],
    opts: { windowsHide: boolean; stdio: 'ignore' }
  ) => { on(event: 'error', listener: (error: Error) => void): unknown };
}

/** 本机进程表；ps 不可用时为空，只杀根进程组 */
export function listProcesses(): ProcessEntry[] {
  try {
    return execFileSync('ps', ['-axo', 'pid=,ppid=,pgid='], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 3000,
    })
      .split('\n')
      .flatMap((line) => {
        const [pid, ppid, pgid] = line.trim().split(/\s+/).map(Number);
        return pid > 0 && ppid >= 0 && pgid > 0 ? [{ pid, ppid, pgid }] : [];
      });
  } catch {
    return [];
  }
}

/**
 * 根进程组，加上根与这些组的全部后代所在的进程组：后代 setsid / setpgid 自立门户
 * （验收脚本 detached 拉起的 Electron、timeout）也算在内。known 是前几轮见过的组：
 * 根先退出后后代已过继给 init，靠它下一轮还认得；表里已没有成员的组丢掉。不碰自己所在的组。
 */
export function treeGroups(
  rootPid: number,
  table: readonly ProcessEntry[],
  known: ReadonlySet<number> = new Set(),
  selfPid = process.pid
): number[] {
  const children = new Map<number, ProcessEntry[]>();
  const members = new Map<number, ProcessEntry[]>();
  for (const entry of table) {
    children.set(entry.ppid, [...(children.get(entry.ppid) ?? []), entry]);
    members.set(entry.pgid, [...(members.get(entry.pgid) ?? []), entry]);
  }
  const own = table.find((entry) => entry.pid === selfPid)?.pgid;
  const groups = new Set<number>();
  const seen = new Set<number>();
  const queue: number[] = [];
  const visit = (pid: number) => {
    if (seen.has(pid)) return;
    seen.add(pid);
    queue.push(pid);
  };
  const addGroup = (group: number) => {
    if (group <= 1 || group === own || groups.has(group)) return;
    groups.add(group);
    for (const entry of members.get(group) ?? []) visit(entry.pid);
  };
  addGroup(rootPid);
  visit(rootPid);
  for (const group of known) if (members.has(group)) addGroup(group);
  while (queue.length > 0) {
    for (const child of children.get(queue.pop() as number) ?? []) {
      addGroup(child.pgid);
      visit(child.pid);
    }
  }
  return [...groups];
}

/** 根的后代里和自己同组的进程：不能向自己的组发信号，只能逐个发（没 detached 的子进程派生的孙进程） */
export function ownGroupDescendants(
  rootPid: number,
  table: readonly ProcessEntry[],
  selfPid = process.pid
): number[] {
  const own = table.find((entry) => entry.pid === selfPid)?.pgid;
  if (own === undefined) return [];
  const children = new Map<number, ProcessEntry[]>();
  for (const entry of table) children.set(entry.ppid, [...(children.get(entry.ppid) ?? []), entry]);
  const found: number[] = [];
  const seen = new Set<number>([rootPid]);
  const queue = [rootPid];
  while (queue.length > 0) {
    for (const child of children.get(queue.pop() as number) ?? []) {
      if (seen.has(child.pid) || child.pid <= 1 || child.pid === selfPid) continue;
      seen.add(child.pid);
      queue.push(child.pid);
      if (child.pgid === own) found.push(child.pid);
    }
  }
  return found;
}

/**
 * POSIX：向 treeGroups 算出的每个进程组发信号，见过的组记进 known；和自己同组的后代逐个发。
 * macOS 的 SIGKILL 先 SIGSTOP 冻住（与 pi 前台中止一致，防 `a; b` 在取消时起 b）。根进程组发不出去时退回 fallback。
 */
export function signalProcessTree(
  rootPid: number,
  signal: NodeJS.Signals,
  known: Set<number> = new Set(),
  deps: TreeDeps = {},
  fallback: () => void = () => {
    try {
      process.kill(rootPid, signal);
    } catch {}
  }
): void {
  const kill = deps.killGroup ?? ((pid, sig) => process.kill(pid, sig));
  const send = (target: number, sig: NodeJS.Signals) => {
    try {
      kill(target, sig);
      return true;
    } catch {
      return false;
    }
  };
  const freeze = (deps.platform ?? process.platform) === 'darwin' && signal === 'SIGKILL';
  if (freeze) send(-rootPid, 'SIGSTOP');
  const table = (deps.listProcesses ?? listProcesses)();
  const groups = treeGroups(rootPid, table, known);
  const strays = ownGroupDescendants(rootPid, table);
  for (const group of groups) known.add(group);
  if (freeze) {
    for (const group of groups) send(-group, 'SIGSTOP');
    for (const pid of strays) send(pid, 'SIGSTOP');
  }
  for (const group of groups) {
    if (!send(-group, signal) && group === rootPid) fallback();
  }
  for (const pid of strays) send(pid, signal);
}

const knownGroups = new WeakMap<KillableChild, Set<number>>();

/**
 * 杀整棵进程树。POSIX：detached 子进程是独立进程组，连同自立门户的后代一起发信号（signalProcessTree）。
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
  if (platform === 'win32') {
    try {
      const root = deps.systemRoot ?? process.env.SystemRoot ?? 'C:\\Windows';
      const spawn = deps.spawn ?? nodeSpawn;
      spawn(path.win32.join(root, 'System32', 'taskkill.exe'), ['/pid', String(pid), '/T', '/F'], {
        windowsHide: true,
        stdio: 'ignore',
      }).on('error', fallback);
    } catch {
      fallback();
    }
    return;
  }
  const known = knownGroups.get(child) ?? new Set<number>();
  knownGroups.set(child, known);
  signalProcessTree(pid, signal, known, deps, fallback);
}
