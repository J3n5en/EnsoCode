export type SessionForkResult =
  | { ok: true; sessionFile: string }
  | { ok: false; error: 'anchor-not-found' | 'branch-not-persisted' };

export type ForkBranchEntry = {
  id: string;
  type: string;
  message?: { role: string };
};

/** 分叉叶子：从锚点扩到下一轮 user 之前（含本轮 assistant）。压缩点不扩。 */
export function resolveForkLeafId(
  branch: readonly ForkBranchEntry[],
  anchor: { entryId: string } | { userIndexFromEnd: number }
): string | undefined {
  let start = -1;
  if ('entryId' in anchor) {
    start = branch.findIndex((entry) => entry.id === anchor.entryId);
    if (start < 0) return undefined;
    if (branch[start]?.type === 'compaction') return branch[start].id;
  } else {
    const users = branch.filter(
      (entry) => entry.type === 'message' && entry.message?.role === 'user'
    );
    const user = users[users.length - 1 - anchor.userIndexFromEnd];
    if (!user) return undefined;
    start = branch.findIndex((entry) => entry.id === user.id);
  }
  if (start < 0) return undefined;
  let leaf = start;
  for (let i = start + 1; i < branch.length; i++) {
    const entry = branch[i];
    if (entry.type === 'message' && entry.message?.role === 'user') break;
    leaf = i;
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
