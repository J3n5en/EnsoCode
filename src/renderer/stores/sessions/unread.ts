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
