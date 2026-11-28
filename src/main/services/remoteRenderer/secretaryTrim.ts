import { IPC_CHANNELS } from '@shared/types/ipc';

/**
 * 秘书看板的「已完成」会一直累积（实测 390 条约 370KB），远端冷启动要整段下载。
 * 远端只用它算今日战报、列「秘书处理中」和判空：留最近若干条、24 小时内派出或出结果的
 * （任何时区的今天零点都在 24 小时内）、还在筛选的就够。
 */
export const REMOTE_DONE_RECENT = 30;
export const REMOTE_DONE_WINDOW_MS = 24 * 60 * 60 * 1000;
/** 历史提案只保留活跃项、24 小时内项和最近 N 条终态项，其余由聊天卡片按需拉回 */
export const REMOTE_PROPOSALS_RECENT = 40;
export const REMOTE_PROPOSALS_WINDOW_MS = 24 * 60 * 60 * 1000;

export interface TrimSecretaryOptions {
  includeAllProposals?: boolean;
}

interface DoneCard {
  startedAt?: number;
  stateSince?: number;
  resultAt?: number;
  triage?: boolean;
}

interface ProposalRecord {
  status?: string;
  createdAt?: number;
  updatedAt?: number;
  resolvedAt?: number;
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

function trimProposals(proposals: Record<string, unknown>, now: number): Record<string, unknown> {
  const entries = Object.entries(proposals);
  if (entries.length <= REMOTE_PROPOSALS_RECENT) return proposals;
  const since = now - REMOTE_PROPOSALS_WINDOW_MS;
  const kept: Record<string, unknown> = {};
  const resolved: { id: string; item: unknown; ts: number }[] = [];

  for (const [id, item] of entries) {
    if (id === '__proto__') continue;
    const p = item && typeof item === 'object' ? (item as ProposalRecord) : undefined;
    if (p?.status === 'pending' || p?.status === 'executing') {
      kept[id] = item;
    } else {
      resolved.push({ id, item, ts: p?.resolvedAt ?? p?.updatedAt ?? p?.createdAt ?? 0 });
    }
  }

  resolved.sort((a, b) => b.ts - a.ts);
  resolved.forEach((entry, index) => {
    if (index < REMOTE_PROPOSALS_RECENT || entry.ts >= since) {
      kept[entry.id] = entry.item;
    }
  });
  return kept;
}

const hasBoard = (value: unknown): value is { board: Board } =>
  !!value &&
  typeof value === 'object' &&
  !!(value as { board?: unknown }).board &&
  typeof (value as { board?: unknown }).board === 'object';

export function trimSecretaryResult(
  channel: string,
  result: unknown,
  now = Date.now(),
  options: TrimSecretaryOptions = {}
): unknown {
  if (channel === IPC_CHANNELS.SECRETARY_GET_STATE) {
    if (!result || typeof result !== 'object' || Array.isArray(result)) return result;
    const state = result as Record<string, unknown>;
    const board = hasBoard(state) ? trimBoard(state.board, now) : state.board;
    const proposals =
      options.includeAllProposals !== true &&
      state.proposals &&
      typeof state.proposals === 'object' &&
      !Array.isArray(state.proposals)
        ? trimProposals(state.proposals as Record<string, unknown>, now)
        : state.proposals;
    return {
      ...state,
      ...(typeof state.persona === 'string' && state.persona.length > 0 ? { persona: '' } : {}),
      ...(hasBoard(state) ? { board } : {}),
      ...(proposals !== undefined ? { proposals } : {}),
    };
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
