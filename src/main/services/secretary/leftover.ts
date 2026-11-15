/**
 * 后台任务的两种形态：等它跑完会唤醒会话的普通任务，和不会自己结束的常驻服务。
 * 常驻服务（dev server、http.server、--watch）用完必须停，会话收口后还在跑就是遗留；
 * 普通任务跑得比任何命令都久，也按遗留看待。判定只看命令与时间，不看输出。
 */
import { classifyCommand } from '../../../agent/shell/policy';

/** 普通后台任务跑这么久还没结束，按常驻看待：不再算「等后台任务」 */
export const PERSISTENT_RUNNING_MS = 30 * 60 * 1000;
/** 跑这么久还没结束，疑似遗留 */
export const LEFTOVER_RUNNING_MS = 2 * 60 * 60 * 1000;
/** 会话收口后常驻服务还跑这么久，就是遗留 */
export const LEFTOVER_SERVICE_GRACE_MS = 10 * 60 * 1000;

/** 命令摘要上限：卡片与推送里只留一句 */
const COMMAND_MAX_CHARS = 80;

/** 监听端口 / 显式 listen 的命令本身就是服务，与 shell 分类互补 */
const SERVICE_FLAGS = /(?:^|\s)(?:--port(?:[\s=]|$)|--listen(?:[\s=:]|$)|\blisten\b)/;

export type LeftoverReason = 'process-gone' | 'overtime' | 'service-after-settle';

/** 判定只需要这几个字段：Main 的投影与 worker 快照都满足 */
export interface TaskLike {
  command: string;
  status: 'running' | 'done' | 'failed';
  startedAt: number;
  alive?: boolean;
}

/** 命令本身是常驻服务：shell 分类的 server 加上端口 / listen 特征 */
export function isPersistentCommand(command: string): boolean {
  if (!command) return false;
  return classifyCommand(command).class === 'server' || SERVICE_FLAGS.test(command);
}

/** 常驻任务：命令是服务，或已经跑过阈值还没结束 */
export function taskIsPersistent(task: TaskLike, now: number): boolean {
  if (isPersistentCommand(task.command)) return true;
  return task.status === 'running' && now - task.startedAt >= PERSISTENT_RUNNING_MS;
}

/**
 * 遗留判定。只对还在跑的任务成立，三种原因按严重程度取第一个：
 * 进程已经不在（最确定）、跑过 2 小时、会话收口后常驻服务还在跑。
 */
export function leftoverReason(
  task: TaskLike,
  input: { now: number; settledAt?: number }
): LeftoverReason | undefined {
  if (task.status !== 'running') return undefined;
  if (task.alive === false) return 'process-gone';
  if (input.now - task.startedAt >= LEFTOVER_RUNNING_MS) return 'overtime';
  if (
    taskIsPersistent(task, input.now) &&
    input.settledAt !== undefined &&
    input.now - input.settledAt >= LEFTOVER_SERVICE_GRACE_MS
  )
    return 'service-after-settle';
  return undefined;
}

/** 一行命令摘要：压掉换行与多余空格，超长截断 */
export function summarizeCommand(command: string): string {
  const one = command.replace(/\s+/g, ' ').trim();
  return one.length > COMMAND_MAX_CHARS ? `${one.slice(0, COMMAND_MAX_CHARS)}…` : one;
}

/** 跑了多久：分钟起步，超过一小时给小时+分钟 */
export function ranText(ms: number): string {
  const minutes = Math.max(0, Math.floor(ms / 60_000));
  if (minutes < 60) return `${minutes} 分钟`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours} 小时` : `${hours} 小时 ${rest} 分钟`;
}

/** 完成回传里的一句提示：还有几个后台任务在跑，分别是什么命令 */
export function leftoverNote(tasks: readonly TaskLike[]): string | undefined {
  const running = tasks.filter((task) => task.status === 'running');
  if (running.length === 0) return undefined;
  const commands = running
    .map((task) => summarizeCommand(task.command))
    .filter(Boolean)
    .join('、');
  const head = `还有 ${running.length} 个后台任务在跑`;
  return commands ? `${head}：${commands}` : head;
}

/** 巡检推送的正文：哪个会话、什么命令、跑了多久、为什么算遗留 */
const REASON_TEXT: Record<LeftoverReason, string> = {
  'process-gone': '进程已不在',
  overtime: `已跑超过 ${LEFTOVER_RUNNING_MS / 3_600_000} 小时`,
  'service-after-settle': `会话收口后常驻服务还在跑`,
};

export function leftoverUpdateText(
  label: string,
  tasks: readonly { task: TaskLike; reason: LeftoverReason }[],
  now: number
): string {
  const detail = tasks
    .map(
      (entry) =>
        `${summarizeCommand(entry.task.command)}（已跑 ${ranText(now - entry.task.startedAt)}，${REASON_TEXT[entry.reason]}）`
    )
    .join('；');
  return [label, `有 ${tasks.length} 个疑似遗留的后台任务`, detail].filter(Boolean).join(' · ');
}
