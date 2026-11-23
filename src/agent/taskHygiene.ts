/**
 * 后台任务收尾与闲置判定：只标记「疑似闲置」，不自动停止任何任务。
 * 采样集中、降频：一轮只 fork 一次 ps 和一次 lsof，只覆盖已安静够久的任务；拿不到数据一律不判闲置。
 */
import { execFile } from 'node:child_process';
import { TASK_WRAP_UP_TAG } from '@shared/turnNotes';
import type { BackgroundTaskInfo, BackgroundTaskKeep } from '@shared/types/agent';

/** 无新输出这么久才进入候选 */
export const IDLE_QUIET_MS = 30 * 60_000;
/** 保留后这么久重新检查 */
export const KEEP_RECHECK_MS = 60 * 60_000;
/** 采样间隔 */
export const IDLE_SAMPLE_INTERVAL_MS = 60_000;
/** 两次采样间进程树 CPU 时间 / 墙钟时间低于它算「基本为 0」 */
export const IDLE_CPU_RATIO = 0.01;

export interface TaskSockets {
  listening: number[];
  established: number;
}

/** 字段缺省 = 这一项拿不到 */
export interface ActivitySample {
  cpuRatio?: number;
  sockets?: TaskSockets;
}

/** 没有新输出、CPU 基本为 0、监听的端口没有活跃连接；不监听端口的只看前两条 */
export function judgeIdle(input: {
  now: number;
  lastOutputAt: number;
  sample?: ActivitySample;
}): boolean {
  const { sample } = input;
  if (input.now - input.lastOutputAt < IDLE_QUIET_MS) return false;
  if (sample?.cpuRatio === undefined || sample.cpuRatio >= IDLE_CPU_RATIO) return false;
  if (!sample.sockets) return false;
  return sample.sockets.listening.length === 0 || sample.sockets.established === 0;
}

export function keepSuppressesIdle(keep: BackgroundTaskKeep | undefined, now: number): boolean {
  return keep !== undefined && now < keep.at + KEEP_RECHECK_MS;
}

/** `[[dd-]hh:]mm:ss[.ss]` → 秒 */
function cpuSeconds(text: string): number | undefined {
  const match = /^(?:(\d+)-)?(\d+(?::\d+){0,2}(?:\.\d+)?)$/.exec(text);
  if (!match) return undefined;
  const parts = (match[2] ?? '').split(':').map(Number);
  if (parts.some((part) => !Number.isFinite(part))) return undefined;
  const seconds = parts.reduce((sum, part) => sum * 60 + part, 0);
  return Number(match[1] ?? 0) * 86_400 + seconds;
}

/** `ps -A -o pid=,ppid=,time=` */
export function parsePsTable(stdout: string): Map<number, { ppid: number; cpuSec: number }> {
  const table = new Map<number, { ppid: number; cpuSec: number }>();
  for (const line of stdout.split('\n')) {
    const [pid, ppid, time] = line.trim().split(/\s+/);
    const cpuSec = time === undefined ? undefined : cpuSeconds(time);
    if (!pid || !ppid || cpuSec === undefined || !/^\d+$/.test(pid) || !/^\d+$/.test(ppid))
      continue;
    table.set(Number(pid), { ppid: Number(ppid), cpuSec });
  }
  return table;
}

/** `lsof -F pfnT -Ts`：按进程汇总 TCP 监听端口与已建立连接 */
export function parseLsofTcp(stdout: string): Map<number, TaskSockets> {
  const result = new Map<number, TaskSockets>();
  let current: TaskSockets | undefined;
  let name = '';
  for (const line of stdout.split('\n')) {
    const tag = line[0];
    const value = line.slice(1);
    if (tag === 'p') {
      const pid = Number(value);
      current = result.get(pid) ?? { listening: [], established: 0 };
      result.set(pid, current);
    } else if (tag === 'f') name = '';
    else if (tag === 'n') name = value;
    else if (tag === 'T' && current) {
      if (value === 'ST=LISTEN') {
        const port = Number(name.slice(name.lastIndexOf(':') + 1));
        if (Number.isInteger(port) && port > 0 && !current.listening.includes(port))
          current.listening.push(port);
      } else if (value === 'ST=ESTABLISHED') current.established += 1;
    }
  }
  return result;
}

export type SampleExec = (
  file: string,
  args: string[]
) => Promise<{ ok: boolean; stdout: string; code?: number }>;

const defaultExec: SampleExec = (file, args) =>
  new Promise((resolve) => {
    execFile(file, args, { timeout: 10_000, maxBuffer: 8 * 1024 * 1024 }, (error, stdout) => {
      const code = (error as { code?: unknown } | null)?.code;
      resolve({
        ok: !error,
        stdout: String(stdout ?? ''),
        ...(typeof code === 'number' ? { code } : {}),
      });
    });
  });

function treeOf(table: Map<number, { ppid: number }>, root: number): number[] {
  if (!table.has(root)) return [];
  const children = new Map<number, number[]>();
  for (const [pid, { ppid }] of table) children.set(ppid, [...(children.get(ppid) ?? []), pid]);
  const tree = [root];
  for (let index = 0; index < tree.length; index++)
    for (const child of children.get(tree[index] ?? -1) ?? [])
      if (!tree.includes(child)) tree.push(child);
  return tree;
}

/** 一轮采样：CPU 取两轮之间的增量，首轮只记基线 */
export class ActivitySampler {
  private baseline = new Map<string, { at: number; cpuSec: number }>();

  constructor(private readonly exec: SampleExec = defaultExec) {}

  async sample(
    tasks: readonly { key: string; pid: number }[],
    now: number
  ): Promise<Map<string, ActivitySample>> {
    const result = new Map<string, ActivitySample>();
    for (const key of this.baseline.keys())
      if (!tasks.some((task) => task.key === key)) this.baseline.delete(key);
    if (tasks.length === 0) return result;
    const ps = await this.exec('ps', ['-A', '-o', 'pid=,ppid=,time=']);
    if (!ps.ok) return result;
    const table = parsePsTable(ps.stdout);
    const trees = new Map(tasks.map((task) => [task.key, treeOf(table, task.pid)]));
    const pids = [...new Set([...trees.values()].flat())];
    if (pids.length === 0) return result;
    const lsof = await this.exec('lsof', [
      '-nP',
      '-a',
      '-iTCP',
      '-p',
      pids.join(','),
      '-F',
      'pfnT',
      '-Ts',
    ]);
    // lsof 没找到任何套接字时退出码为 1、输出为空；别的失败（不存在、超时）当作拿不到
    const sockets =
      lsof.ok || (lsof.code === 1 && !lsof.stdout.trim()) ? parseLsofTcp(lsof.stdout) : undefined;
    for (const task of tasks) {
      const tree = trees.get(task.key) ?? [];
      if (tree.length === 0) {
        this.baseline.delete(task.key);
        continue;
      }
      const cpuSec = tree.reduce((sum, pid) => sum + (table.get(pid)?.cpuSec ?? 0), 0);
      const base = this.baseline.get(task.key);
      this.baseline.set(task.key, { at: now, cpuSec });
      const sample: ActivitySample = {};
      if (base && now > base.at)
        sample.cpuRatio = Math.max(0, cpuSec - base.cpuSec) / ((now - base.at) / 1000);
      if (sockets) {
        const merged: TaskSockets = { listening: [], established: 0 };
        for (const pid of tree) {
          const own = sockets.get(pid);
          if (!own) continue;
          for (const port of own.listening)
            if (!merged.listening.includes(port)) merged.listening.push(port);
          merged.established += own.established;
        }
        sample.sockets = merged;
      }
      result.set(task.key, sample);
    }
    return result;
  }
}

function ranText(ms: number): string {
  const minutes = Math.max(0, Math.floor(ms / 60_000));
  return minutes < 60 ? `${minutes}m` : `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

function taskLines(tasks: readonly BackgroundTaskInfo[], now: number): string[] {
  return tasks.map(
    (task) =>
      `- ${task.taskId}: ${task.command.replace(/\s+/g, ' ').slice(0, 160)} (running ${ranText(now - task.startedAt)})`
  );
}

/** 收尾清单：还在跑、没表态（没保留）的任务；没有返回 undefined */
export function settleChecklist(
  tasks: readonly BackgroundTaskInfo[],
  now: number
): string | undefined {
  const open = tasks.filter((task) => task.status === 'running' && !task.keep);
  if (open.length === 0) return undefined;
  return [
    `<${TASK_WRAP_UP_TAG}>`,
    'These background tasks are still running and you have not said what happens to them:',
    ...taskLines(open, now),
    'Call task_settle once for all of them: stop each one you no longer need, or keep it with a one-line reason the user will see. Do not leave them undeclared.',
    `</${TASK_WRAP_UP_TAG}>`,
  ].join('\n');
}

/** 子代理的 Run 因这些任务被持有：等结果就结束回合，该在汇报后继续跑的 keep，不要的 stop */
export function awaitChecklist(tasks: readonly BackgroundTaskInfo[], now: number): string {
  return [
    'These background tasks you started are still running:',
    ...taskLines(tasks, now),
    'Your Run waits for them before it reports back. If you need their results, end your turn; each completion wakes you. Keep tasks that should run on after your report (such as servers) with task_settle keep, and stop the ones you no longer need.',
  ].join('\n');
}
