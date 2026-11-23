/**
 * 回退入口的纯判定：可见性、唤醒资格、时间线锚点。
 * spawn IPC ack 时 spawning 仍为 true；含该会话的 snapshot 或 parent-ready 会清 spawning，
 * worker 此时已 register，命令进同一 gate。热/冷发送前共用 shouldSendRewindCommand。
 */

import { joinSkillCommands, splitSkillBlocks } from '@shared/skillCommands';
import { splitTurnNotes } from '@shared/turnNotes';

export interface ConversationRewindView {
  started: boolean;
  spawning?: boolean;
  status: string;
  historyOnly?: boolean;
  parentId?: string;
  sessionFile?: string;
  historyBaseIndex?: number;
  worktreeMissing?: boolean;
  workspaceMigrating?: boolean;
  rewinding?: boolean;
  restoringFiles?: boolean;
}

export interface RewindHost {
  canRewind: boolean;
}

export interface ForkHost extends RewindHost {
  canFork?: boolean;
}

/** 分支层级上限：root 为第 1 层，每层分支都是一份完整上下文副本 */
export const MAX_FORK_DEPTH = 3;

/** 沿 forkedFrom 链计层；来源已删除仍计入该层，成环时停在重复节点前 */
export function forkDepth(
  conversations: Readonly<Record<string, { forkedFromConversationId?: string } | undefined>>,
  conversationId: string
): number {
  const seen = new Set([conversationId]);
  let parent = conversations[conversationId]?.forkedFromConversationId;
  while (parent && !seen.has(parent)) {
    seen.add(parent);
    parent = conversations[parent]?.forkedFromConversationId;
  }
  return seen.size;
}

export function canWakeConversationForRewind(conversation: ConversationRewindView): boolean {
  return (
    !conversation.started &&
    !conversation.spawning &&
    !conversation.parentId &&
    Boolean(conversation.sessionFile) &&
    !conversation.historyOnly &&
    !conversation.worktreeMissing &&
    !conversation.workspaceMigrating &&
    conversation.status !== 'running'
  );
}

export function canShowConversationRewind(
  conversation: ConversationRewindView | null | undefined,
  host?: RewindHost | null
): boolean {
  if (host && !host.canRewind) return false;
  if (!conversation || conversation.historyOnly) return false;
  if (conversation.worktreeMissing || conversation.workspaceMigrating) return false;
  if (conversation.spawning || conversation.status === 'running') return false;
  if (conversation.rewinding || conversation.restoringFiles) return false;
  if (conversation.started) return true;
  return canWakeConversationForRewind(conversation);
}

/** 分支入口：热主会话需 idle 且非 spawning；未激活的冷主会话由 store 先唤醒再分叉；层级到上限不显示 */
export function canShowConversationFork(
  conversation: ConversationRewindView | null | undefined,
  host?: ForkHost | null,
  depth = 1
): boolean {
  if (host && (!host.canRewind || host.canFork === false)) return false;
  if (depth >= MAX_FORK_DEPTH) return false;
  if (!conversation || conversation.parentId || conversation.historyOnly) return false;
  if (conversation.status !== 'idle') return false;
  if (conversation.started) return !conversation.spawning;
  return canWakeConversationForRewind(conversation);
}

export function shouldSendRewindCommand(conversation: ConversationRewindView | undefined): boolean {
  return Boolean(
    conversation?.started &&
      !conversation.spawning &&
      conversation.status !== 'running' &&
      !conversation.historyOnly &&
      !conversation.worktreeMissing &&
      !conversation.workspaceMigrating &&
      !conversation.rewinding &&
      !conversation.restoringFiles
  );
}

export type RewindWorkerPhase = 'wait' | 'ready' | 'failed';

export function rewindWorkerPhase(
  conversation: ConversationRewindView | undefined,
  expectedSessionFile: string | undefined
): RewindWorkerPhase {
  if (
    !conversation ||
    conversation.sessionFile !== expectedSessionFile ||
    conversation.historyOnly ||
    conversation.worktreeMissing ||
    conversation.workspaceMigrating
  ) {
    return 'failed';
  }
  if (shouldSendRewindCommand(conversation)) return 'ready';
  if (
    !conversation.started ||
    conversation.status === 'failed' ||
    conversation.status === 'running'
  ) {
    return 'failed';
  }
  return 'wait';
}

interface RewindMessages {
  messages: readonly { role: string; entryId?: string; optimistic?: boolean }[];
  historyBaseIndex?: number;
}

export function resolveRewindTarget(
  conversation: RewindMessages,
  anchor: string | number
): { entryId: string; userIndexFromEnd: number } | null {
  const index =
    typeof anchor === 'string'
      ? conversation.messages.findIndex((message) => message.entryId === anchor)
      : rewindKeepCount(conversation.messages, anchor);
  if (index === null || index < 0) return null;
  const message = conversation.messages[index];
  if (message?.role !== 'user' || message.optimistic || !message.entryId?.trim()) return null;
  return {
    entryId: message.entryId,
    userIndexFromEnd: conversation.messages.slice(index + 1).filter((item) => item.role === 'user')
      .length,
  };
}

export function resolveRewindConfirm(
  originId: string,
  displayedId: string | null | undefined,
  conversation: RewindMessages | undefined,
  absIndex: number,
  entryId?: string
): { conversationId: string; entryId: string; userIndexFromEnd: number } | null {
  if (!conversation || displayedId !== originId) return null;
  const anchor = entryId ?? userIndexFromEndForTimelineKey(conversation, absIndex);
  if (anchor === null) return null;
  const target = resolveRewindTarget(conversation, anchor);
  return target ? { conversationId: originId, ...target } : null;
}

export function userIndexFromEndForTimelineKey(
  conversation: { messages: readonly { role: string }[]; historyBaseIndex?: number },
  absIndex: number
): number | null {
  if (!Number.isInteger(absIndex) || absIndex < 0) return null;
  const localIndex = absIndex - (conversation.historyBaseIndex ?? 0);
  if (localIndex < 0 || conversation.messages[localIndex]?.role !== 'user') return null;
  return conversation.messages.slice(localIndex + 1).filter((message) => message.role === 'user')
    .length;
}

type TurnInputCandidate = {
  role: string;
  entryId?: string;
  optimistic?: boolean;
  pluginSource?: unknown;
};

/**
 * 轮次输入：已落盘的用户消息（含宿主合成注入）或插件投递，与 worker 的 isTurnInputEntry 同口径。
 * 压缩摘要、隐藏 custom、toolResult、本地乐观回显都不开新一轮。
 */
export function isTurnInput(message: TurnInputCandidate): boolean {
  if (message.optimistic) return false;
  return message.role === 'user' || (message.role === 'custom' && Boolean(message.pluginSource));
}

/**
 * 轮末行 key（绝对下标）→ 分叉锚点：优先本轮 user 的 entryId，压缩前的早期轮次与 worker 计数口径无关。
 * 本轮由插件投递触发、user 无 entryId 或在未加载的更早页时，按其后的轮次输入数从末尾定位，由 worker 校验。
 */
export function forkAnchorForTurnKey(
  conversation: {
    messages: readonly TurnInputCandidate[];
    historyBaseIndex?: number;
  },
  absIndex: number
): { entryId: string } | { turnIndexFromEnd: number } | null {
  if (!Number.isInteger(absIndex)) return null;
  const base = conversation.historyBaseIndex ?? 0;
  const local = absIndex - base;
  if (local < 0 || local >= conversation.messages.length) return null;
  const turnIndexFromEnd = conversation.messages.slice(local + 1).filter(isTurnInput).length;
  for (let i = local; i >= 0; i--) {
    const message = conversation.messages[i];
    if (!isTurnInput(message)) continue;
    return message.role === 'user' && message.entryId
      ? { entryId: message.entryId }
      : { turnIndexFromEnd };
  }
  return base > 0 ? { turnIndexFromEnd } : null;
}

/** 回退到倒数第 N+1 条 user：保留它之前的消息（不含该 user）。对不上返回 null。 */
export function rewindKeepCount(
  messages: readonly { role: string }[],
  userIndexFromEnd: number
): number | null {
  if (!Number.isInteger(userIndexFromEnd) || userIndexFromEnd < 0) return null;
  const users: number[] = [];
  for (let i = 0; i < messages.length; i++) {
    if (messages[i]?.role === 'user') users.push(i);
  }
  const target = users[users.length - 1 - userIndexFromEnd];
  if (target === undefined) return null;
  return target;
}

type RewindDraftPart = {
  type: string;
  text?: string;
  data?: string;
  mimeType?: string;
};

/** 从即将裁掉的目标 user 消息抽出草稿，不必等 worker navigateTree。 */
export function extractRewindDraft(
  messages: readonly { role: string; content?: readonly RewindDraftPart[] }[],
  userIndexFromEnd: number
): { text?: string; images?: { data: string; mimeType: string }[] } | null {
  const keep = rewindKeepCount(messages, userIndexFromEnd);
  if (keep === null) return null;
  const target = messages[keep];
  if (target?.role !== 'user' || !Array.isArray(target.content)) return null;
  const text = target.content
    .filter((part) => part.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text)
    .join('');
  const images = target.content.flatMap((part) =>
    part.type === 'image' && part.data && part.mimeType
      ? [{ data: part.data, mimeType: part.mimeType }]
      : []
  );
  if (!text && images.length === 0) return {};
  return {
    ...(text ? { text: collapseSkillBlock(text) } : {}),
    ...(images.length > 0 ? { images } : {}),
  };
}

// pi 已把 /skill:name 展开成 XML；原样回填会让输入拦截器（如 poteto 模式）再包一层
function collapseSkillBlock(text: string): string {
  const blocks = splitSkillBlocks(text);
  return blocks
    ? joinSkillCommands(
        blocks.skills.map((skill) => skill.name),
        splitTurnNotes(blocks.rest).rest
      )
    : text;
}
