/** 桌面 resume 与手机 pair 共用的尾窗条数上限 */
export const SNAPSHOT_TAIL_MESSAGES = 60;
/** UTF-8 JSON 字节预算（pair 加密封帧还会膨胀） */
export const SNAPSHOT_BYTE_BUDGET = 600_000;

/**
 * 从 endIndex 往前取，直到条数或字节预算耗尽。
 * 至少保留 1 条（单条超预算也发）。endIndex=0 返回空窗。
 */
export function takeSnapshotTail(
  messages: unknown[],
  endIndex: number
): { messages: unknown[]; baseIndex: number } {
  let bytes = 0;
  let start = endIndex;
  while (start > 0 && endIndex - start < SNAPSHOT_TAIL_MESSAGES) {
    const size = Buffer.byteLength(JSON.stringify(messages[start - 1]), 'utf8');
    if (bytes + size > SNAPSHOT_BYTE_BUDGET && start < endIndex) break;
    bytes += size;
    start--;
    if (bytes > SNAPSHOT_BYTE_BUDGET) break;
  }
  return { messages: messages.slice(start, endIndex), baseIndex: start };
}

/** resume 下行：长历史先尾窗再全量；短历史只发全量避免重复帧 */
export function resumeSnapshotPayloads<T>(
  messages: T[]
): Array<{ messages: T[]; baseIndex: number }> {
  const tail = takeSnapshotTail(messages, messages.length);
  if (tail.baseIndex === 0 && tail.messages.length === messages.length) {
    return [{ messages, baseIndex: 0 }];
  }
  return [
    { messages: tail.messages as T[], baseIndex: tail.baseIndex },
    { messages, baseIndex: 0 },
  ];
}
