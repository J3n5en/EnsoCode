import { IPC_CHANNELS } from '@shared/types/ipc';

/**
 * 秘书看板的「已完成」会一直累积（实测 390 条约 370KB），远端冷启动要整段下载。
 * 远端只用它算今日战报、列「秘书处理中」和判空：留最近若干条、24 小时内派出或出结果的
 * （任何时区的今天零点都在 24 小时内）、还在筛选的就够。
 */
export const REMOTE_DONE_RECENT = 30;
export const REMOTE_DONE_WINDOW_MS = 24 * 60 * 60 * 1000;

interface DoneCard {
  startedAt?: number;
  stateSince?: number;
  resultAt?: number;
  triage?: boolean;
}

type Board = { done?: unknown };

function trimBoard<T extends Board>(board: T, now: number): T {
  if (!Array.isArray(board.done) || board.done.length <= REMOTE_DONE_RECENT) return board;
  const since = now - REMOTE_DONE_WINDOW_MS;
  const done = (board.done as DoneCard[]).filter(
    (card, index) =>
      index < REMOTE_DONE_RECENT ||
      card.triage === true ||
      (card.startedAt ?? 0) >= since ||
      (card.resultAt ?? card.stateSince ?? 0) >= since
  );
  return { ...board, done };
}

const hasBoard = (value: unknown): value is { board: Board } =>
  !!value &&
  typeof value === 'object' &&
  !!(value as { board?: unknown }).board &&
  typeof (value as { board?: unknown }).board === 'object';

export function trimSecretaryResult(channel: string, result: unknown, now = Date.now()): unknown {
  if (channel === IPC_CHANNELS.SECRETARY_GET_STATE) {
    return hasBoard(result) ? { ...result, board: trimBoard(result.board, now) } : result;
  }
  if (channel === IPC_CHANNELS.SECRETARY_OVERVIEW) {
    const boards = (result as { boards?: unknown } | null)?.boards;
    if (!Array.isArray(boards)) return result;
    return {
      ...(result as object),
      boards: boards.map((entry) =>
        hasBoard(entry) ? { ...entry, board: trimBoard(entry.board, now) } : entry
      ),
    };
  }
  return result;
}
