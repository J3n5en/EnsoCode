import path from 'node:path';
import { type SessionEntry, sessionEntryToContextMessages } from '@earendil-works/pi-coding-agent';
import { takeSnapshotTail } from '@shared/snapshotTail';
import type { ProjectedMessage } from '@shared/types/agent';
import { projectMessage } from '../../agent/projection';
import { withUserEntryIds } from '../../agent/transcript';

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
  beforeIndex: number
): {
  messages: ProjectedMessage[];
  baseIndex: number;
} {
  return projectWindow(
    withUserEntryIds(branch.flatMap(sessionEntryToContextMessages), branch),
    beforeIndex
  );
}

export function projectParentHistoryTail(branch: readonly SessionEntry[]): {
  messages: ProjectedMessage[];
  baseIndex: number;
} {
  const raw = withUserEntryIds(branch.flatMap(sessionEntryToContextMessages), branch);
  return projectWindow(raw, raw.length);
}

/** 全量投影：worker 无投影的会话合成快照用（分页由快照链路按绝对 index 切） */
export function projectParentHistoryAll(branch: readonly SessionEntry[]): ProjectedMessage[] {
  return withUserEntryIds(branch.flatMap(sessionEntryToContextMessages), branch)
    .map(projectMessage)
    .filter((message): message is ProjectedMessage => message !== null);
}
