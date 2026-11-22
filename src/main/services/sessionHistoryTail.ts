import path from 'node:path';
import { type SessionEntry, sessionEntryToContextMessages } from '@earendil-works/pi-coding-agent';
import { takeSnapshotTail } from '@shared/snapshotTail';
import type { ProjectedMessage } from '@shared/types/agent';
import { projectMessage } from '../../agent/projection';
import { withPrivacyMask, withUserEntryIds } from '../../agent/transcript';

export interface HistoryProjectionOptions {
  /** 每条消息带上 jsonl entry id（任意角色）；秘书跨分页定位用，渲染层历史不带 */
  messageIds?: boolean;
}

function displayMessages(
  branch: readonly SessionEntry[],
  options: HistoryProjectionOptions = {}
): unknown[] {
  const raw = branch.flatMap(sessionEntryToContextMessages);
  const shown = withPrivacyMask(withUserEntryIds(raw, branch), branch);
  if (!options.messageIds) return shown;
  const ids = new Map<unknown, string>();
  for (const entry of branch)
    if (entry.type === 'message' && entry.id) ids.set(entry.message, entry.id);
  // 上面两步都是逐条 map，按位置对回原始消息对象再查 id
  return shown.map((message, i) => {
    const messageId = ids.get(raw[i]);
    return messageId && typeof message === 'object' && message !== null
      ? { ...message, messageId }
      : message;
  });
}

export function resolveParentHistoryFile(
  sessionDir: string,
  sessionFile: string | undefined
): string | null {
  if (!sessionFile) return null;
  const root = path.resolve(sessionDir);
  const resolved = path.resolve(sessionFile);
  const within = resolved === root || resolved.startsWith(`${root}${path.sep}`);
  return within ? resolved : null;
}

function projectWindow(
  raw: unknown[],
  endIndex: number
): {
  messages: ProjectedMessage[];
  baseIndex: number;
} {
  const end = Math.max(0, Math.min(endIndex, raw.length));
  if (end === 0) return { messages: [], baseIndex: 0 };
  const window = takeSnapshotTail(raw, end);
  return {
    messages: window.messages
      .map(projectMessage)
      .filter((message): message is ProjectedMessage => message !== null),
    baseIndex: window.baseIndex,
  };
}

export function projectParentHistoryPage(
  branch: readonly SessionEntry[],
  beforeIndex: number,
  options?: HistoryProjectionOptions
): {
  messages: ProjectedMessage[];
  baseIndex: number;
} {
  return projectWindow(displayMessages(branch, options), beforeIndex);
}

export function projectParentHistoryTail(
  branch: readonly SessionEntry[],
  options?: HistoryProjectionOptions
): {
  messages: ProjectedMessage[];
  baseIndex: number;
} {
  const raw = displayMessages(branch, options);
  return projectWindow(raw, raw.length);
}

/** 全量投影：worker 无投影的会话合成快照用（分页由快照链路按绝对 index 切） */
export function projectParentHistoryAll(
  branch: readonly SessionEntry[],
  options?: HistoryProjectionOptions
): ProjectedMessage[] {
  return displayMessages(branch, options)
    .map(projectMessage)
    .filter((message): message is ProjectedMessage => message !== null);
}

/** 全量投影里按 jsonl entry id（优先）或绝对下标取一条；取不到返回 null */
export function findHistoryMessage(
  messages: readonly ProjectedMessage[],
  target: { entryId: string } | { index: number }
): { index: number; message: ProjectedMessage } | null {
  const index =
    'entryId' in target
      ? messages.findIndex((message) => message.messageId === target.entryId)
      : target.index;
  const message = messages[index];
  return message ? { index, message } : null;
}
