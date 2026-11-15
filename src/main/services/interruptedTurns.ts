import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { appendCappedLog } from '@shared/cappedLog';
import {
  EXIT_RECORD_MAX_AGE_MS,
  exitWindowOf,
  type InterruptedTurn,
  inExitWindow,
  interruptReason,
  isExitCausedStreamError,
  parseInterruptedTurns,
} from '@shared/exitInterrupt';
import type { ProjectedMessage } from '@shared/types/agent';
import { clearRunningAtExit, readRunningAtExit } from './runningAtExit';

export const INTERRUPTED_TURNS_LOG = 'interrupted-turns.log';
/** 本次启动认定的中断事实：秘书启动时同步读它说明原因（渲染层走 IPC 取） */
export const INTERRUPTED_TURNS_FACTS = 'interrupted-turns.json';

export function writeInterruptedTurnFacts(
  agentDir: string,
  turns: readonly InterruptedTurn[]
): void {
  const file = path.join(agentDir, INTERRUPTED_TURNS_FACTS);
  if (turns.length === 0) return;
  mkdirSync(agentDir, { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(turns), { mode: 0o600 });
  renameSync(tmp, file);
}

export function readInterruptedTurnFacts(agentDir: string): InterruptedTurn[] {
  try {
    return parseInterruptedTurns(
      JSON.parse(readFileSync(path.join(agentDir, INTERRUPTED_TURNS_FACTS), 'utf8'))
    );
  } catch {
    return [];
  }
}

/** 事实文件只描述「本次启动」：每次恢复前先清，避免上次的旧原因被套到新会话上 */
function clearInterruptedTurnFacts(agentDir: string): void {
  rmSync(path.join(agentDir, INTERRUPTED_TURNS_FACTS), { force: true });
}

/** 秘书回传里的原因文案：带上几点被关、什么原因、哪些工具可能只跑了一半 */
export function interruptedTurnReason(
  agentDir: string,
  conversationId: string
): string | undefined {
  const turn = readInterruptedTurnFacts(agentDir).find(
    (candidate) => candidate.conversationId === conversationId
  );
  if (!turn) return undefined;
  return interruptReason({
    at: turn.exitAt,
    kind: turn.kind,
    unfinishedTools: turn.unfinishedTools,
    lang: 'zh',
  });
}

/** 中断时还没有结果的工具调用名（可能已经执行了一半） */
export function unfinishedToolNames(messages: readonly ProjectedMessage[]): string[] {
  const names = new Map<string, string>();
  for (const message of messages) {
    if (message.role === 'toolResult') {
      if (message.toolCallId) names.delete(message.toolCallId);
      continue;
    }
    if (message.role !== 'assistant') continue;
    for (const part of message.content) {
      if (part.type !== 'toolCall') continue;
      names.set(part.id, part.name);
    }
  }
  return [...names.values()];
}

/** 末条 assistant 的终态错误：进程被杀时模型层只会留下断流/断连 */
function terminalErrorOf(messages: readonly ProjectedMessage[]): {
  text: string;
  at: number;
} | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role !== 'assistant') continue;
    if (!message.errorMessage) return null;
    return { text: message.errorMessage, at: message.timestamp ?? 0 };
  }
  return null;
}

export interface RecoverInterruptedTurnsInput {
  /** userData/agent */
  agentDir: string;
  /** 本次启动时刻 */
  startupAt: number;
  now?: number;
  pid?: number;
  pidAlive?: (pid: number) => boolean;
  /** 会话 jsonl 投影；读不到返回 null */
  readMessages: (conversationId: string) => Promise<readonly ProjectedMessage[] | null>;
}

function defaultPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM：进程在，只是不归我们管
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * 启动时取走上次退出留下的记录，产出「被退出打断的回合」。
 * 记录只消费一次；进程还在、记录过旧、坏文件都当作没有中断。
 */
export async function recoverInterruptedTurns(
  input: RecoverInterruptedTurnsInput
): Promise<InterruptedTurn[]> {
  const now = input.now ?? Date.now();
  const pid = input.pid ?? process.pid;
  const record = readRunningAtExit(input.agentDir);
  clearInterruptedTurnFacts(input.agentDir);
  if (!record) return [];
  clearRunningAtExit(input.agentDir);
  if (record.pid === pid) return [];
  if (now - record.at > EXIT_RECORD_MAX_AGE_MS) return [];
  if ((input.pidAlive ?? defaultPidAlive)(record.pid)) return [];
  const window = exitWindowOf(record, input.startupAt);
  const turns: InterruptedTurn[] = [];
  for (const session of record.sessions) {
    const messages = (await input.readMessages(session.conversationId)) ?? [];
    const error = terminalErrorOf(messages);
    const suppressedError =
      error && isExitCausedStreamError(error.text) && inExitWindow(error.at || record.at, window)
        ? error.text
        : undefined;
    turns.push({
      conversationId: session.conversationId,
      ...(session.turnId ? { turnId: session.turnId } : {}),
      ...(session.startedAt ? { startedAt: session.startedAt } : {}),
      exitAt: record.at,
      kind: record.kind,
      ...(session.lastMessageIndex === undefined
        ? {}
        : { lastMessageIndex: session.lastMessageIndex }),
      unfinishedTools: unfinishedToolNames(messages),
      ...(suppressedError ? { suppressedError } : {}),
    });
  }
  appendCappedLog(
    path.join(input.agentDir, INTERRUPTED_TURNS_LOG),
    `${new Date(now).toISOString()} pid=${record.pid} kind=${record.kind} at=${record.at} window=${window.from}..${window.to} sessions=${turns
      .map(
        (turn) =>
          `${turn.conversationId}(tools=${turn.unfinishedTools.length}${
            turn.suppressedError ? ',swallowed' : ''
          })`
      )
      .join(',')}`
  );
  writeInterruptedTurnFacts(input.agentDir, turns);
  return turns;
}
