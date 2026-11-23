import { PLUGIN_MESSAGE_TYPE } from '@shared/extensionPlugins/protocol';

export type SessionForkResult =
  | { ok: true; sessionFile: string }
  | { ok: false; error: 'anchor-not-found' | 'branch-not-persisted' };

export type ForkBranchEntry = {
  id: string;
  type: string;
  customType?: string;
  message?: { role: string };
};

/** 轮次输入：用户消息或插件投递，都开启新一轮并进入模型上下文 */
export function isTurnInputEntry(entry: Omit<ForkBranchEntry, 'id'>): boolean {
  return entry.type === 'custom_message'
    ? entry.customType === PLUGIN_MESSAGE_TYPE
    : entry.type === 'message' && entry.message?.role === 'user';
}

/**
 * 分叉叶子：锚点所在轮的最后一条上下文条目（message / custom_message），与原会话该轮结束时的上下文一致；
 * 之后才发生的压缩、切模型等不带上。压缩点不扩。
 */
export function resolveForkLeafId(
  branch: readonly ForkBranchEntry[],
  anchor: { entryId: string } | { turnIndexFromEnd: number }
): string | undefined {
  let start = -1;
  if ('entryId' in anchor) {
    start = branch.findIndex((entry) => entry.id === anchor.entryId);
    if (start < 0) return undefined;
    if (branch[start]?.type === 'compaction') return branch[start].id;
  } else {
    const inputs = branch.filter(isTurnInputEntry);
    const input = inputs[inputs.length - 1 - anchor.turnIndexFromEnd];
    if (!input) return undefined;
    start = branch.indexOf(input);
  }
  let leaf = start;
  for (let i = start + 1; i < branch.length && !isTurnInputEntry(branch[i]); i++) {
    if (branch[i].type === 'message' || branch[i].type === 'custom_message') leaf = i;
  }
  return branch[leaf]?.id;
}

export function branchSessionAtLeaf(
  manager: {
    createBranchedSession(leafId: string): string | undefined;
    getEntry(id: string): { id: string } | undefined;
  },
  leafId: string
): SessionForkResult {
  if (!manager.getEntry(leafId)) return { ok: false, error: 'anchor-not-found' };
  const sessionFile = manager.createBranchedSession(leafId);
  if (!sessionFile) return { ok: false, error: 'branch-not-persisted' };
  return { ok: true, sessionFile };
}

/**
 * pi 的 createBranchedSession 会就地改当前 SessionManager（sessionFile + 内存树）。
 * 必须先打开源 jsonl 副本再分叉，否则源会话被吃掉。
 */
export function branchSessionFromPersistedFile(
  source: {
    getSessionFile(): string | undefined;
    getEntry(id: string): { id: string } | undefined;
  },
  leafId: string,
  openCopy: (sessionFile: string) => {
    createBranchedSession(leafId: string): string | undefined;
    getEntry(id: string): { id: string } | undefined;
  }
): SessionForkResult {
  const sessionFile = source.getSessionFile();
  if (!sessionFile || !source.getEntry(leafId)) return { ok: false, error: 'anchor-not-found' };
  return branchSessionAtLeaf(openCopy(sessionFile), leafId);
}
