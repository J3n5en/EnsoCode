import { type SessionEntry, sessionEntryToContextMessages } from '@earendil-works/pi-coding-agent';
import { OM_FOLDED } from './continuousMemory/session-ledger/types';

/**
 * 渲染层要的是完整对话记录，而 pi 的 `session.messages` 是 LLM 上下文视图：
 * compaction 之后只剩 summary + 保留段 + 新消息，之前的历史被丢掉。
 * 这里把被摘要掉的那段从分支路径补回到 context 前面；更早的 compaction
 * 也按 pi 的映射变成 compactionSummary 消息留在原位。
 * 后半段沿用 context 本身，保证与运行中 message_start/update 的下标对齐。
 */
export function transcriptMessages(
  sessionManager: { getBranch(): SessionEntry[] },
  contextMessages: unknown[]
): unknown[] {
  const branch = sessionManager.getBranch();
  let compactionIndex = -1;
  for (let i = branch.length - 1; i >= 0; i--) {
    if (branch[i].type === 'compaction') {
      compactionIndex = i;
      break;
    }
  }
  if (compactionIndex < 0) return contextMessages;
  const compaction = branch[compactionIndex] as Extract<SessionEntry, { type: 'compaction' }>;
  const keptIndex = compaction.firstKeptEntryId
    ? branch.findIndex((entry) => entry.id === compaction.firstKeptEntryId)
    : -1;
  const cut = keptIndex >= 0 && keptIndex < compactionIndex ? keptIndex : compactionIndex;
  const summarized = branch.slice(0, cut).flatMap(sessionEntryToContextMessages);
  return stampCompactionFromHook([...summarized, ...contextMessages], branch);
}

function isMemoryFolded(details: unknown): boolean {
  return (
    typeof details === 'object' &&
    details !== null &&
    (details as { type?: unknown }).type === OM_FOLDED
  );
}

/** 按 compaction 条目顺序给 compactionSummary 打标：fromHook = Enso hook 产出；compactionSource='memory' = 持续记忆渲染。 */
function stampCompactionFromHook(messages: unknown[], branch: SessionEntry[]): unknown[] {
  const flags = branch
    .filter(
      (entry): entry is Extract<SessionEntry, { type: 'compaction' }> => entry.type === 'compaction'
    )
    .map((entry) => ({
      fromHook: entry.fromHook === true,
      memory: entry.fromHook === true && isMemoryFolded(entry.details),
    }));
  if (!flags.some((flag) => flag.fromHook)) return messages;
  let i = 0;
  return messages.map((message) => {
    if (
      !message ||
      typeof message !== 'object' ||
      (message as { role?: unknown }).role !== 'compactionSummary'
    ) {
      return message;
    }
    const flag = flags[i++];
    if (!flag?.fromHook) return message;
    return {
      ...(message as object),
      fromHook: true,
      ...(flag.memory ? { compactionSource: 'memory' } : {}),
    };
  });
}
