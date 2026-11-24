import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { inspect } from 'node:util';
import {
  AGENT_WORKER_ABORT_LOG,
  AGENT_WORKER_CRASH_FILE,
  type AgentWorkerCrash,
} from '@shared/agentWorkerExit';
import { appendCappedLog } from '@shared/cappedLog';

/**
 * 只认 AbortSignal 链路产生的两种形态：Node 内部 AbortError（code=ABORT_ERR）与 DOMException 的
 * AbortError / TimeoutError。只是 name 或文案相同的自定义错误可能是真缺陷，照旧让 worker 退出。
 */
export function isAbortLike(error: unknown): boolean {
  if (error instanceof DOMException)
    return error.name === 'AbortError' || error.name === 'TimeoutError';
  return (
    error instanceof Error &&
    error.name === 'AbortError' &&
    (error as { code?: unknown }).code === 'ABORT_ERR'
  );
}

function describeError(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

interface CrashRecordOptions {
  target?: Pick<NodeJS.EventEmitter, 'on'>;
  exit?: (code: number) => void;
}

/**
 * 致命异常（含默认模式下升级成异常的未处理 rejection）退出前同步落盘，供 Main 在 exit 时报告。
 * 唯一例外是逃逸的取消类异常：取消是预期内的控制流而非程序缺陷，吞掉只丢那一个已被取消的操作，
 * 不吞则整个 worker 连同所有会话的当前轮次一起退出。其余异常照旧落盘后以 1 退出。
 * 不另挂 unhandledRejection：桌面 utilityProcess 的未处理 rejection 只告警不退出，服务器 fork 的 Node 默认
 * throw 模式会以 origin=unhandledRejection 走到这里；挂了会改掉两边原有的语义。
 */
export function installCrashRecord(dataDir: string, options: CrashRecordOptions = {}): void {
  const target = options.target ?? process;
  const exit = options.exit ?? ((code: number) => process.exit(code));
  target.on('uncaughtExceptionMonitor', (error: unknown, origin: string) => {
    if (isAbortLike(error)) return;
    try {
      const memory = process.memoryUsage();
      const crash: AgentWorkerCrash = {
        pid: process.pid,
        at: Date.now(),
        origin,
        message: describeError(error),
        stack: error instanceof Error ? error.stack : undefined,
        rss: memory.rss,
        heapUsed: memory.heapUsed,
      };
      writeFileSync(path.join(dataDir, AGENT_WORKER_CRASH_FILE), JSON.stringify(crash), 'utf8');
    } catch {}
  });
  target.on('uncaughtException', (error: unknown, origin: string) => {
    const text = `origin=${origin} ${inspect(error)}`;
    if (isAbortLike(error)) {
      console.warn(`[agent] swallowed escaped abort ${text}`);
      appendCappedLog(path.join(dataDir, AGENT_WORKER_ABORT_LOG), `pid=${process.pid} ${text}`);
      return;
    }
    // 接管后 Node 不再打印和退出，按默认行为补上
    try {
      process.stderr.write(`${text}\n`);
    } catch {}
    exit(1);
  });
}
