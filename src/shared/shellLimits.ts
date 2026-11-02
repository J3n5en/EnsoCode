/** 前台命令连续无新输出达到此时长即在时间线标「静默」（agent 与渲染层徽章同源） */
export const SHELL_QUIET_MS = 15_000;

/** 命令执行的全部时限 / 配额，单点定义；测试与覆盖都从这里取 */
export interface ShellLimits {
  /** 普通前台命令到点让位（转后台并回执）的时长 */
  yieldDefaultMs: number;
  /** 构建 / 测试 / 安装类命令的让位时长 */
  yieldBuildMs: number;
  /** 不会自己退出的命令（dev server / watch / tail -f）的让位时长 */
  yieldServerMs: number;
  /** 连续无输出多久算静默（渲染层徽章） */
  quietMs: number;
  /** task_output 单次阻塞等待上限 */
  taskWaitMaxMs: number;
  /** 后台任务并发配额（整个 worker 共用） */
  maxTasks: number;
  /** 单个任务磁盘日志的写入上限；超出停写并标记截断，不杀进程 */
  logMaxBytes: number;
  /** SIGTERM 后未退的宽限，超时 SIGKILL */
  killGraceMs: number;
}

export const SHELL_LIMITS: Readonly<ShellLimits> = Object.freeze({
  yieldDefaultMs: 45_000,
  yieldBuildMs: 180_000,
  yieldServerMs: 10_000,
  quietMs: SHELL_QUIET_MS,
  taskWaitMaxMs: 30_000,
  maxTasks: 20,
  logMaxBytes: 256 * 1024 * 1024,
  killGraceMs: 5_000,
});

/** setTimeout 上限，超出会被 Node 当成 1ms */
const MAX_TIMER_MS = 2_147_483_647;

const MS_KEYS = [
  'yieldDefaultMs',
  'yieldBuildMs',
  'yieldServerMs',
  'quietMs',
  'taskWaitMaxMs',
  'killGraceMs',
] as const;

const positive = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value > 0;

/** settings.shell 覆盖解析：只认识已知键，坏值逐项回落默认，不抛错 */
export function resolveShellLimits(raw: unknown): ShellLimits {
  const limits: ShellLimits = { ...SHELL_LIMITS };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return limits;
  const record = raw as Record<string, unknown>;
  for (const key of MS_KEYS) {
    const value = record[key];
    if (positive(value) && value <= MAX_TIMER_MS) limits[key] = value;
  }
  if (positive(record.maxTasks) && record.maxTasks >= 1) {
    limits.maxTasks = Math.floor(record.maxTasks);
  }
  if (positive(record.logMaxBytes)) limits.logMaxBytes = Math.floor(record.logMaxBytes);
  return limits;
}
