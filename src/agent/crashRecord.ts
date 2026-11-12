import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { AGENT_WORKER_CRASH_FILE, type AgentWorkerCrash } from '@shared/agentWorkerExit';

/**
 * 致命异常（含默认模式下升级成异常的未处理 rejection）退出前同步落盘，供 Main 在 exit 时报告。
 * 用 Monitor 只观察不接管：退出语义保持 Node 默认。
 */
export function installCrashRecord(dataDir: string): void {
  process.on('uncaughtExceptionMonitor', (error, origin) => {
    try {
      const memory = process.memoryUsage();
      const crash: AgentWorkerCrash = {
        pid: process.pid,
        at: Date.now(),
        origin,
        message: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
        stack: error instanceof Error ? error.stack : undefined,
        rss: memory.rss,
        heapUsed: memory.heapUsed,
      };
      writeFileSync(path.join(dataDir, AGENT_WORKER_CRASH_FILE), JSON.stringify(crash), 'utf8');
    } catch {}
  });
}
