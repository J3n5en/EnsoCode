import { appendFileSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  AGENT_WORKER_CRASH_FILE,
  AGENT_WORKER_EXIT_LOG,
  type AgentWorkerCrash,
  parseAgentWorkerCrash,
} from '@shared/agentWorkerExit';

/** 取走本 pid 留下的崩溃记录；他人的旧记录保留不动 */
export function takeAgentWorkerCrash(
  dataDir: string,
  pid: number | undefined
): AgentWorkerCrash | null {
  const file = path.join(dataDir, AGENT_WORKER_CRASH_FILE);
  let crash: AgentWorkerCrash | null;
  try {
    crash = parseAgentWorkerCrash(JSON.parse(readFileSync(file, 'utf8')));
  } catch {
    return null;
  }
  if (!crash || crash.pid !== pid) return null;
  try {
    unlinkSync(file);
  } catch {}
  return crash;
}

/** 打包后 stdout/stderr 不可见，退出原因只能靠这份日志事后查 */
export function appendAgentWorkerExitLog(
  dataDir: string,
  text: string,
  maxBytes = 512 * 1024
): void {
  const file = path.join(dataDir, AGENT_WORKER_EXIT_LOG);
  const line = `[${new Date().toISOString()}] ${text}\n`;
  try {
    let size = 0;
    try {
      size = statSync(file).size;
    } catch {}
    if (size + line.length > maxBytes) writeFileSync(file, line, 'utf8');
    else appendFileSync(file, line, 'utf8');
  } catch {}
}
