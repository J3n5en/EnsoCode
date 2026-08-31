/** 手机当前订阅的会话：完成后不标未读，与桌面正在看等价 */
let pairViewedId: string | null = null;

export function setPairViewedSession(id: string | null): void {
  pairViewedId = id;
}

export function isPairViewed(id: string): boolean {
  return pairViewedId === id;
}

/** 完成未读标记：后台会话 running→idle 时置位,用户查看时清除(侧栏绿点) */
export function nextUnread(opts: {
  prevStatus: string;
  nextStatus: string;
  prevUnread?: boolean;
  viewed: boolean;
}): boolean {
  if (opts.viewed) return false;
  if (opts.prevStatus === 'running' && opts.nextStatus === 'idle') return true;
  return opts.prevUnread ?? false;
}
