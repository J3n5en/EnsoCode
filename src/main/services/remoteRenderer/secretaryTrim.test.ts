import { describe, expect, it } from 'vitest';
import { REMOTE_DONE_RECENT, REMOTE_DONE_WINDOW_MS, trimSecretaryResult } from './secretaryTrim';

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
});
