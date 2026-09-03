export type SessionForkResult =
  | { ok: true; sessionFile: string }
  | { ok: false; error: 'anchor-not-found' | 'branch-not-persisted' };

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
