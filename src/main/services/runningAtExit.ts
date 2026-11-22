import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  type ExitKind,
  parseRunningAtExit,
  RUNNING_AT_EXIT_FILE,
  type RunningAtExitEntry,
  type RunningAtExitRecord,
} from '@shared/exitInterrupt';

export function runningAtExitPath(dir: string): string {
  return path.join(dir, RUNNING_AT_EXIT_FILE);
}

/**
 * 退出路径上同步写：tmp + rename，写到一半被 SIGKILL 也不会留下半份 JSON。
 * 没有正在跑的会话就删文件，避免下次启动误标。
 */
export function writeRunningAtExit(
  dir: string,
  input: { pid: number; kind: ExitKind; at: number; sessions: readonly RunningAtExitEntry[] }
): void {
  const file = runningAtExitPath(dir);
  if (input.sessions.length === 0) {
    rmSync(file, { force: true });
    return;
  }
  const record: RunningAtExitRecord = {
    v: 1,
    at: input.at,
    pid: input.pid,
    kind: input.kind,
    sessions: input.sessions.map((session) => ({ ...session })),
  };
  mkdirSync(dir, { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(record), { mode: 0o600 });
  renameSync(tmp, file);
}

export function readRunningAtExit(dir: string): RunningAtExitRecord | null {
  try {
    return parseRunningAtExit(JSON.parse(readFileSync(runningAtExitPath(dir), 'utf8')));
  } catch {
    return null;
  }
}

export function clearRunningAtExit(dir: string): void {
  rmSync(runningAtExitPath(dir), { force: true });
}

/**
 * 退出记录：同一次退出 before-quit 会来两次（will-quit 收尾完再 app.quit），第二次时回合已被
 * 收尾停掉，不能把第一次记下的在跑会话删掉；记下之后心跳也停，免得收尾期间被清空。
 * 只在退出已确定（committed）时这样做：被拦下的 before-quit（确认框取消）照旧按当下快照写。
 */
export function createExitRecorder(input: {
  dir: string;
  pid: number;
  snapshot: () => readonly RunningAtExitEntry[];
  committed: () => boolean;
  now?: () => number;
  stopHeartbeat?: () => void;
}): { record: (kind: ExitKind) => void } {
  let kept = false;
  return {
    record(kind) {
      const sessions = input.snapshot();
      const committed = input.committed();
      if (committed && kept && sessions.length === 0) return;
      if (committed) input.stopHeartbeat?.();
      writeRunningAtExit(input.dir, {
        pid: input.pid,
        kind,
        at: (input.now ?? Date.now)(),
        sessions,
      });
      kept = committed && (kept || sessions.length > 0);
    },
  };
}

/**
 * 心跳：被 SIGKILL 时来不及写退出记录，靠最后一次心跳把「退出时刻」框到 20 秒内，
 * 启动时才能判断断流错误是否落在退出窗口里。没有正在跑的会话时不写盘。
 */
export function startRunningAtExitHeartbeat(input: {
  dir: string;
  pid: number;
  kind: ExitKind;
  snapshot: () => readonly RunningAtExitEntry[];
  now?: () => number;
  intervalMs?: number;
}): { stop: () => void; beat: () => void } {
  const beat = (): void => {
    try {
      writeRunningAtExit(input.dir, {
        pid: input.pid,
        kind: input.kind,
        at: (input.now ?? Date.now)(),
        sessions: input.snapshot(),
      });
    } catch (error) {
      console.error('Failed to write running-at-exit heartbeat:', error);
    }
  };
  const timer = setInterval(beat, input.intervalMs ?? 20_000);
  timer.unref?.();
  return { beat, stop: () => clearInterval(timer) };
}
