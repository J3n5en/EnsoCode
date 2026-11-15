import type { ExitKind, InterruptedTurn } from '@shared/exitInterrupt';
import type { NodeStatus } from '@shared/types/agent';

/** 会话状态：worker 的 idle/running/failed 之外，多一个「被应用退出打断」 */
export type ConversationStatus = NodeStatus | 'interrupted';

/** 会话被应用退出打断的事实：随会话持久化，重试或新回合开始时清除 */
export interface InterruptedTurnState {
  /** 应用关闭时刻 */
  at: number;
  kind: ExitKind;
  /** 中断时没有结果的工具调用名：可能只执行了一半 */
  unfinishedTools: string[];
  /** 被判定为「退出导致」而吞掉的模型错误原文 */
  suppressedError?: string;
}

export function interruptedStateOf(turn: InterruptedTurn): InterruptedTurnState {
  return {
    at: turn.exitAt,
    kind: turn.kind,
    unfinishedTools: [...turn.unfinishedTools],
    ...(turn.suppressedError ? { suppressedError: turn.suppressedError } : {}),
  };
}

/**
 * 只有本地已知、且此刻没在跑的会话才标中断：
 * 陌生 id（会话已删）与正在跑的会话（新一轮已经开始）都不能被旧记录盖掉。
 */
export function shouldMarkInterrupted(
  conversation: { status: ConversationStatus } | undefined
): boolean {
  if (!conversation) return false;
  return conversation.status !== 'running';
}
