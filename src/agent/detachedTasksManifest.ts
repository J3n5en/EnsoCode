import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { redactSafeText } from './ensoSafeJournal';
import { isRunId } from './shell/detachedRun';

/** 重启前从 worker 脱离、留给下一代认回的后台任务清单（dataDir 下，和 restart-checkpoint.json 同目录） */
export const DETACHED_TASKS_FILE = 'restart-background-tasks.json';
/** worker 收尾时停掉的在跑后台任务：下一代据此在任务表留一条「因重启中断」并通知所属会话一次 */
export const INTERRUPTED_TASKS_FILE = 'restart-interrupted-tasks.json';

export interface InterruptedTaskRecord {
  taskId: string;
  sessionId: string;
  /** 命令摘要：截断并抹掉疑似密钥 */
  command: string;
  startedAt: number;
  stoppedAt: number;
  logPath: string;
  /** 常驻服务（dev server 等）：只通知，不建议自动重跑 */
  resident: boolean;
}

export interface DetachedTaskRecord {
  taskId: string;
  sessionId: string;
  /** 命令摘要：截断并抹掉疑似密钥，只用于展示 */
  command: string;
  /** 原命令 + cwd 的指纹：认回后拦同一命令的重复启动 */
  commandKey: string | null;
  cwd: string;
  pid: number;
  /** 写在进程命令行与环境变量里的标记，认回时据此核对 pid 没被复用 */
  runId: string;
  startedAt: number;
  /** 进程实际启动的时刻：命令 exec 换掉 shell 后命令行里没有 runId，靠它与 pid 的启动时间核对 */
  runStartedAt?: number;
  yieldedAt: number | null;
  deadlineAt: number | null;
  /** 进程 stdout/stderr 直写的文件与已读字节数 */
  outputFile: string;
  outputOffset: number;
  /** 退出码记录方式：shell 的 EXIT trap 把 $? 写进这个文件；被 SIGKILL 等没跑 trap 时没有 */
  exitCodeFile: string;
  logPath: string;
}

export interface DetachedTasksManifest {
  version: 1;
  writtenAt: number;
  workerPid: number;
  tasks: DetachedTaskRecord[];
}

const COMMAND_SUMMARY_LIMIT = 300;
const TASK_ID = /^task-\d+-[0-9a-z]+$/;
/** 命令里常见的密钥写法：KEY=值、--token 值 / --password=值 */
const SECRET_ASSIGNMENT =
  /\b([A-Za-z0-9_]*?(?:key|token|secret|passw(?:or)?d|pwd|auth|credential)[A-Za-z0-9_]*)=("[^"]*"|'[^']*'|\S+)/gi;
const SECRET_FLAG =
  /(--?[A-Za-z0-9-]*?(?:key|token|secret|passw(?:or)?d|auth|credential)[A-Za-z0-9-]*)(=|\s+)("[^"]*"|'[^']*'|[^\s-]\S*)/gi;

export function commandSummary(command: string): string {
  const redacted = redactSafeText(
    command.replace(SECRET_ASSIGNMENT, '$1=[REDACTED]').replace(SECRET_FLAG, '$1$2[REDACTED]')
  ).trim();
  return redacted.length > COMMAND_SUMMARY_LIMIT
    ? `${redacted.slice(0, COMMAND_SUMMARY_LIMIT)}…`
    : redacted;
}

export function commandKey(command: string, cwd: string): string {
  return createHash('sha256')
    .update(`${path.resolve(cwd)}\0${command.trim()}`)
    .digest('hex');
}

export function writeDetachedTasksManifest(file: string, manifest: DetachedTasksManifest): void {
  if (manifest.tasks.length === 0) {
    rmSync(file, { force: true });
    return;
  }
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(manifest, null, 2));
  renameSync(tmp, file);
}

const isNum = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);
const isStr = (value: unknown): value is string => typeof value === 'string' && value.length > 0;
const numOrNull = (value: unknown): value is number | null => value === null || isNum(value);

/**
 * 读后即删（只认一次）。文件路径不信清单：输出 / 退出码 / 日志必须就是 logDir 下按 runId、taskId
 * 推出来的那几个文件，否则整条丢掉——清单被改过也读不到、删不到别处的文件。
 */
export function takeDetachedTasksManifest(file: string, logDir: string): DetachedTaskRecord[] {
  let raw: string;
  try {
    raw = readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  rmSync(file, { force: true });
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  const record = parsed as Partial<DetachedTasksManifest> | null;
  if (record?.version !== 1 || !Array.isArray(record.tasks)) return [];
  const same = (a: string, b: string) => path.resolve(a) === path.resolve(b);
  return record.tasks.filter((task): task is DetachedTaskRecord => {
    const t = task as Partial<DetachedTaskRecord> | null;
    return (
      !!t &&
      isStr(t.taskId) &&
      TASK_ID.test(t.taskId) &&
      isStr(t.sessionId) &&
      typeof t.command === 'string' &&
      (t.commandKey === null || isStr(t.commandKey)) &&
      isStr(t.cwd) &&
      isNum(t.pid) &&
      Number.isInteger(t.pid) &&
      t.pid > 0 &&
      isRunId(t.runId) &&
      isNum(t.startedAt) &&
      (t.runStartedAt === undefined || isNum(t.runStartedAt)) &&
      numOrNull(t.yieldedAt) &&
      numOrNull(t.deadlineAt) &&
      isNum(t.outputOffset) &&
      t.outputOffset >= 0 &&
      isStr(t.outputFile) &&
      same(t.outputFile, path.join(logDir, `run-${t.runId}.out`)) &&
      isStr(t.exitCodeFile) &&
      same(t.exitCodeFile, path.join(logDir, `run-${t.runId}.exit`)) &&
      isStr(t.logPath) &&
      same(t.logPath, path.join(logDir, `${t.taskId}.log`))
    );
  });
}

/** 追加（同一 taskId 以新的为准）：上一代还没认领的记录不能被本代覆盖掉 */
export function appendInterruptedTasks(
  file: string,
  records: readonly InterruptedTaskRecord[]
): void {
  if (records.length === 0) return;
  const merged = new Map<string, InterruptedTaskRecord>();
  for (const record of [...readInterrupted(file, null), ...records])
    merged.set(record.taskId, record);
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify({ version: 1, tasks: [...merged.values()] }, null, 2));
  renameSync(tmp, file);
}

/** 读后即删（只通知一次）；日志路径必须就是 logDir 下按 taskId 推出的那个文件 */
export function takeInterruptedTasks(file: string, logDir: string): InterruptedTaskRecord[] {
  const records = readInterrupted(file, logDir);
  rmSync(file, { force: true });
  return records;
}

function readInterrupted(file: string, logDir: string | null): InterruptedTaskRecord[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return [];
  }
  const tasks = (parsed as { version?: unknown; tasks?: unknown } | null)?.tasks;
  if ((parsed as { version?: unknown }).version !== 1 || !Array.isArray(tasks)) return [];
  return tasks.filter((task): task is InterruptedTaskRecord => {
    const t = task as Partial<InterruptedTaskRecord> | null;
    return (
      !!t &&
      isStr(t.taskId) &&
      TASK_ID.test(t.taskId) &&
      isStr(t.sessionId) &&
      typeof t.command === 'string' &&
      isNum(t.startedAt) &&
      isNum(t.stoppedAt) &&
      typeof t.resident === 'boolean' &&
      isStr(t.logPath) &&
      (logDir === null || path.resolve(t.logPath) === path.resolve(logDir, `${t.taskId}.log`))
    );
  });
}
