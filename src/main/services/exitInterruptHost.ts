import { existsSync } from 'node:fs';
import path from 'node:path';
import { app } from '@platform';
import {
  type ExitKind,
  exitWindowOf,
  type InterruptedTurn,
  type RunningAtExitEntry,
} from '@shared/exitInterrupt';
import type { ProjectedMessage } from '@shared/types/agent';
import { agentSessionIndex } from '../ipc/sessionIndex';
import { isAppQuitting } from './appQuitWatchdog';
import { coldResumedSessionIds } from './coldRestart';
import { setExitInterruption } from './exitWindow';
import { recoverInterruptedTurns } from './interruptedTurns';
import { createExitRecorder, startRunningAtExitHeartbeat } from './runningAtExit';
import { projectParentHistoryAll, resolveParentHistoryFile } from './sessionHistoryTail';

/** 本次启动时刻：退出窗口的右边界从这里算 */
const STARTUP_AT = Date.now();

let exitKind: ExitKind = 'quit';
let recovered: Promise<InterruptedTurn[]> | null = null;
let taken = false;

function agentDir(): string {
  return path.join(app.getPath('userData'), 'agent');
}

/** 安装更新重启：退出记录要写明原因，会话提示才能说清是被安装更新关掉的 */
export function markExitForUpdate(): void {
  exitKind = 'update';
}

let heartbeat: { stop: () => void } | null = null;
let exitRecorder: ReturnType<typeof createExitRecorder> | null = null;

/** 退出路径上同步写：只记正在跑的会话，没有就不留文件（顺带清掉旧心跳）；同一次退出不被后来的空快照抹掉 */
export function recordRunningSessionsAtExit(kind: ExitKind = exitKind): void {
  try {
    exitRecorder ??= createExitRecorder({
      dir: agentDir(),
      pid: process.pid,
      snapshot: () => agentSessionIndex.runningTurnSnapshot(),
      committed: isAppQuitting,
      stopHeartbeat: () => heartbeat?.stop(),
    });
    exitRecorder.record(kind);
  } catch (error) {
    console.error('Failed to record running sessions at exit:', error);
  }
}

/**
 * 被 SIGKILL 时来不及写退出记录，靠心跳把「退出时刻」框到 20 秒内。
 * 没有正在跑的会话时心跳不写盘，空闲不影响性能。
 */
export function startRunningSessionsHeartbeat(): { stop: () => void } {
  heartbeat = startRunningAtExitHeartbeat({
    dir: agentDir(),
    pid: process.pid,
    kind: 'quit',
    snapshot: (): readonly RunningAtExitEntry[] => agentSessionIndex.runningTurnSnapshot(),
  });
  return heartbeat;
}

async function readSessionMessages(
  conversationId: string
): Promise<readonly ProjectedMessage[] | null> {
  const persisted = agentSessionIndex.persistedConversation(conversationId);
  const sessionFile =
    typeof persisted?.sessionFile === 'string' ? persisted.sessionFile : undefined;
  const sessionDir = path.join(app.getPath('userData'), 'agent', 'sessions');
  const resolved = resolveParentHistoryFile(sessionDir, sessionFile);
  if (!resolved || !existsSync(resolved)) return null;
  try {
    const { SessionManager } = await import('@earendil-works/pi-coding-agent');
    return projectParentHistoryAll(SessionManager.open(resolved, sessionDir).getBranch());
  } catch {
    return null;
  }
}

function recover(): Promise<InterruptedTurn[]> {
  recovered ??= recoverInterruptedTurns({
    agentDir: agentDir(),
    startupAt: STARTUP_AT,
    readMessages: readSessionMessages,
  })
    .then((turns) => {
      // 退出窗口要在启动后立刻生效：退出瞬间的断流错误可能晚一步才回流
      if (turns.length > 0)
        setExitInterruption({
          at: turns[0].exitAt,
          kind: turns[0].kind,
          window: exitWindowOf({ at: turns[0].exitAt }, STARTUP_AT),
        });
      return turns;
    })
    .catch((error) => {
      console.error('Failed to recover interrupted turns:', error);
      return [];
    });
  return recovered;
}

/** 启动时调一次：先认出上次退出，再让窗口生效 */
export function startExitInterruptRecovery(): void {
  void recover();
}

/** 渲染层启动时取一次；重复取为空，刷新窗口不会重复标记 */
export async function takeInterruptedTurns(): Promise<InterruptedTurn[]> {
  if (taken) return [];
  const turns = await recover();
  taken = true;
  // 停在安全点、冷启动由 Main 续跑的会话不算被打断
  const resumed = coldResumedSessionIds();
  return turns.filter((turn) => !resumed.has(turn.conversationId));
}
