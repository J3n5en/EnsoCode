/** worker 致命异常时同步落盘的记录（相对 ENSO_AGENT_DATA_DIR），Main 在 exit 时取走 */
export const AGENT_WORKER_CRASH_FILE = 'worker-crash.json';
/** Main 追加写的 worker 退出日志（相对 ENSO_AGENT_DATA_DIR） */
export const AGENT_WORKER_EXIT_LOG = 'worker-exits.log';

export interface AgentWorkerCrash {
  pid: number;
  at: number;
  origin: string;
  message: string;
  stack?: string;
  rss?: number;
  heapUsed?: number;
}

export function parseAgentWorkerCrash(raw: unknown): AgentWorkerCrash | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.pid !== 'number' || typeof r.at !== 'number') return null;
  if (typeof r.origin !== 'string' || typeof r.message !== 'string') return null;
  const crash: AgentWorkerCrash = { pid: r.pid, at: r.at, origin: r.origin, message: r.message };
  if (typeof r.stack === 'string') crash.stack = r.stack;
  if (typeof r.rss === 'number') crash.rss = r.rss;
  if (typeof r.heapUsed === 'number') crash.heapUsed = r.heapUsed;
  return crash;
}

/** Windows 进程异常码：大退出码按无符号十六进制显示 */
const WINDOWS_EXIT_CODES: Record<number, string> = {
  3758096392: 'out of memory',
  3221225477: 'access violation',
  3221225725: 'stack overflow',
  3221226505: 'fatal error (fail-fast)',
  // 0xFFFF7003 crashpad：未启用崩溃上报时 native 崩溃以此码自杀，原始异常码丢失
  4294930435: 'native crash, crash handler not connected',
};

function formatExitCode(code: unknown): string {
  if (typeof code !== 'number' || !Number.isFinite(code)) return 'code=unknown';
  const unsigned = code >>> 0;
  if (code >= 0 && code < 0x10000) return `code=${code}`;
  const hex = `0x${unsigned.toString(16).toUpperCase()}`;
  const meaning = WINDOWS_EXIT_CODES[unsigned];
  return meaning ? `code=${hex} ${meaning}` : `code=${hex}`;
}

/** 一行可读的退出原因：有崩溃记录优先给异常首行，否则只有退出码 */
export function describeAgentWorkerExit(code: unknown, crash: AgentWorkerCrash | null): string {
  const exit = formatExitCode(code);
  if (!crash) return exit;
  const first = crash.message.split('\n', 1)[0].trim();
  const rss = crash.rss === undefined ? '' : `, rss=${Math.round(crash.rss / 1024 ** 2)}MB`;
  return `${crash.origin}: ${first} (${exit}${rss})`;
}
