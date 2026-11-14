/** 手机当前订阅的会话：完成后不标未读，与桌面正在看等价 */
let pairViewedId: string | null = null;

export function setPairViewedSession(id: string | null): void {
  pairViewedId = id;
}

export function isPairViewed(id: string): boolean {
  return pairViewedId === id;
}

/**
 * 未读标记：后台会话 running→idle 或转为失败时置位,用户查看时清除。
 * 秘书负责的会话不置位：结果推给秘书，用户在侧栏不需要绿点。
 */
export function nextUnread(opts: {
  prevStatus: string;
  nextStatus: string;
  prevUnread?: boolean;
  viewed: boolean;
  secretaryOwned?: boolean;
}): boolean {
  if (opts.viewed) return false;
  if (opts.secretaryOwned) return false;
  if (opts.prevStatus === 'running' && opts.nextStatus === 'idle') return true;
  if (opts.prevStatus !== 'failed' && opts.nextStatus === 'failed') return true;
  return opts.prevUnread ?? false;
}
