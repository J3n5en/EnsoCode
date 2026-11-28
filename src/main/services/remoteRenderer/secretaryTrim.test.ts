import { describe, expect, it } from 'vitest';
import {
  REMOTE_DONE_RECENT,
  REMOTE_DONE_WINDOW_MS,
  REMOTE_PROPOSALS_RECENT,
  REMOTE_PROPOSALS_WINDOW_MS,
  trimSecretaryResult,
} from './secretaryTrim';

const NOW = 10 * REMOTE_DONE_WINDOW_MS;
const OLD = NOW - 2 * REMOTE_DONE_WINDOW_MS;
const card = (i: number, extra: Record<string, unknown> = {}) => ({
  kind: 'session',
  conversationId: `c${i}`,
  startedAt: OLD,
  stateSince: OLD,
  resultAt: OLD - i,
  ...extra,
});
const ids = (cards: { conversationId: string }[]) => cards.map((c) => c.conversationId);

describe('trimSecretaryResult', () => {
  const done = [
    card(0, { resultAt: NOW - 1000 }),
    ...Array.from({ length: REMOTE_DONE_RECENT + 20 }, (_, i) => card(i + 1)),
    card(900, { triage: true }),
    card(901, { startedAt: NOW - 1000 }),
  ];

  it('已完成只留最近若干条、近期派出或出结果的、还在秘书筛选的', () => {
    const state = { enabled: true, board: { needsYou: [], running: [], todos: [], done } };
    const out = trimSecretaryResult('secretary:get-state', state, NOW) as typeof state;
    expect(ids(out.board.done)).toEqual([
      ...ids(done.slice(0, REMOTE_DONE_RECENT)),
      'c900',
      'c901',
    ]);
    expect(state.board.done).toHaveLength(done.length);
  });

  it('总览里每个秘书的看板同样裁剪', () => {
    const result = { ok: true, boards: [{ secretaryId: 's1', board: { done } }] };
    const out = trimSecretaryResult('secretary:overview', result, NOW) as typeof result;
    expect(out.boards[0]?.board.done).toHaveLength(REMOTE_DONE_RECENT + 2);
  });

  it('其他通道与坏形状原样返回', () => {
    const state = { board: { done } };
    expect(trimSecretaryResult('settings:read', state, NOW)).toBe(state);
    expect(trimSecretaryResult('secretary:get-state', null, NOW)).toBeNull();
    expect(trimSecretaryResult('secretary:overview', { ok: false }, NOW)).toEqual({ ok: false });
  });

  it('secretary:get-state 始终置空 persona，默认裁剪陈旧终态 proposals 并保留活跃/近期/最近 N 条', () => {
    const propNow = 10 * REMOTE_PROPOSALS_WINDOW_MS;
    const propOld = propNow - 2 * REMOTE_PROPOSALS_WINDOW_MS;
    const proposals: Record<string, Record<string, unknown>> = {
      pPendingOld: { id: 'pPendingOld', status: 'pending', createdAt: 1, updatedAt: 1 },
      pExecOld: { id: 'pExecOld', status: 'executing', createdAt: 2, updatedAt: 2 },
      pRecentWindow: {
        id: 'pRecentWindow',
        status: 'succeeded',
        createdAt: 3,
        updatedAt: propNow - 1000,
        resolvedAt: propNow - 1000,
      },
    };
    for (let i = 0; i < REMOTE_PROPOSALS_RECENT + 15; i++) {
      proposals[`pOld${i}`] = {
        id: `pOld${i}`,
        status: i % 2 === 0 ? 'succeeded' : 'rejected',
        createdAt: propOld - 1000 + i,
        updatedAt: propOld - 1000 + i,
        resolvedAt: propOld - 1000 + i,
      };
    }

    const state = {
      enabled: true,
      persona: 'super long system persona '.repeat(100),
      board: { needsYou: [], running: [], todos: [], done },
      proposals,
    };

    const trimmed = trimSecretaryResult('secretary:get-state', state, propNow) as typeof state;
    expect(trimmed.persona).toBe('');
    expect(trimmed.proposals.pPendingOld).toBeDefined();
    expect(trimmed.proposals.pExecOld).toBeDefined();
    expect(trimmed.proposals.pRecentWindow).toBeDefined();
    // 较新的历史提案保留，最旧的被裁掉
    expect(trimmed.proposals[`pOld${REMOTE_PROPOSALS_RECENT + 14}`]).toBeDefined();
    expect(trimmed.proposals.pOld0).toBeUndefined();
    expect(state.persona.length).toBeGreaterThan(0);

    // includeAllProposals: true 时保留全量提案，仍置空 persona 与裁剪 done
    const full = trimSecretaryResult('secretary:get-state', state, propNow, {
      includeAllProposals: true,
    }) as typeof state;
    expect(full.persona).toBe('');
    expect(Object.keys(full.proposals)).toHaveLength(Object.keys(proposals).length);
    expect(full.proposals.pOld0).toBeDefined();
  });
});
