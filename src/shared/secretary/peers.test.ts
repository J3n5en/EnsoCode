import { describe, expect, it } from 'vitest';
import type { SecretaryDispatchFile, SecretaryUpdate } from '../types/secretary';
import {
  intersectProjectSets,
  nextPeerLink,
  PEER_HOP_LIMIT,
  PEER_PAIR_LIMIT,
  PEER_SENDER_LIMIT,
  PeerRateLimiter,
  peerTriggerOf,
} from './peers';

function peer(key: string, hop: number, origins: string[], chain = 'c1'): SecretaryUpdate {
  return {
    key,
    at: 1,
    text: 'hi',
    kind: 'peer-message',
    fromSecretaryId: origins.at(-1) ?? 'a',
    fromName: 'A',
    chain,
    hop,
    origins,
  };
}

function file(
  outbox: SecretaryUpdate[],
  keys: string[],
  conversation = 'sec-b'
): Pick<SecretaryDispatchFile, 'inflight' | 'outbox'> {
  return {
    outbox,
    inflight: {
      deliveryId: 'd',
      secretaryConversationId: conversation,
      keys,
      attempt: 1,
      nextAttemptAt: 0,
    },
  };
}

describe('peerTriggerOf', () => {
  it('只有在途批次里的同事消息才算触发', () => {
    const outbox = [peer('p1', 2, ['a', 'c']), peer('p2', 1, ['d'], 'c2')];
    expect(peerTriggerOf(file(outbox, ['p1', 'p2']), 'sec-b')).toEqual({
      chain: 'c1',
      hop: 2,
      origins: ['a', 'c', 'd'],
    });
    expect(peerTriggerOf(file(outbox, ['p1']), 'other')).toBeNull();
    expect(peerTriggerOf(file(outbox, []), 'sec-b')).toBeNull();
  });

  it('系统回执（hop 0）不算触发', () => {
    expect(peerTriggerOf(file([peer('r', 0, ['a'])], ['r']), 'sec-b')).toBeNull();
  });
});

describe('nextPeerLink', () => {
  it('没有触发开新链；有触发就接着数，超过上限拦下', () => {
    expect(nextPeerLink(null, 'a', () => 'new')).toEqual({
      ok: true,
      chain: 'new',
      hop: 1,
      origins: ['a'],
    });
    expect(nextPeerLink({ chain: 'c', hop: 1, origins: ['a'] }, 'b', () => 'x')).toEqual({
      ok: true,
      chain: 'c',
      hop: 2,
      origins: ['a', 'b'],
    });
    // 1→2→3→4 都过，第 5 跳拦下
    expect(
      nextPeerLink({ chain: 'c', hop: PEER_HOP_LIMIT, origins: ['a', 'b'] }, 'a', () => 'x')
    ).toEqual({ ok: false, error: 'chain-limit' });
  });
});

describe('PeerRateLimiter', () => {
  it('有向一对与单个发送方各自限速', () => {
    const limiter = new PeerRateLimiter();
    for (let index = 0; index < PEER_PAIR_LIMIT; index += 1) limiter.record('a', 'b', index);
    expect(limiter.check('a', 'b', 100)).toBe('rate-limited');
    expect(limiter.check('b', 'a', 100)).toBe('ok');
    // 一小时后窗口过去
    expect(limiter.check('a', 'b', 60 * 60 * 1000 + 100)).toBe('ok');
    const busy = new PeerRateLimiter();
    for (let index = 0; index < PEER_SENDER_LIMIT; index += 1) busy.record('a', `t${index}`, index);
    expect(busy.check('a', 'fresh', 100)).toBe('rate-limited');
  });
});

describe('intersectProjectSets', () => {
  it('交集；没有集合时为空', () => {
    expect(intersectProjectSets([['p1', 'p2'], ['p2', 'p3'], ['p2']])).toEqual(['p2']);
    expect(intersectProjectSets([])).toEqual([]);
  });
});
