import type { SecretaryDispatchFile, SecretaryUpdate } from '../types/secretary';

/** 一条秘书间消息链最多几跳：第 5 跳被拦下，交给用户 */
export const PEER_HOP_LIMIT = 4;
/** 有向一对秘书：每小时最多 20 条 */
export const PEER_PAIR_LIMIT = 20;
export const PEER_PAIR_WINDOW_MS = 60 * 60 * 1000;
/** 单个秘书：每 10 分钟最多发 30 条 */
export const PEER_SENDER_LIMIT = 30;
export const PEER_SENDER_WINDOW_MS = 10 * 60 * 1000;
export const PEER_MESSAGE_MAX = 4000;

type PeerUpdate = Extract<SecretaryUpdate, { kind: 'peer-message' }>;

/** 触发当前回合的秘书间消息：链 id、最大跳数与链上全部发起方 */
export interface PeerTrigger {
  chain: string;
  hop: number;
  origins: string[];
}

/**
 * 这个秘书会话正在处理的投递批次里有没有同事的消息。有就说明这一回合由它触发：
 * 回合里再发的消息继承这条链，读写范围按链上所有发起方取交集。
 * hop 为 0 的是系统回执（托付的待办办完了），不算触发。
 */
export function peerTriggerOf(
  file: Pick<SecretaryDispatchFile, 'inflight' | 'outbox'>,
  conversationId: string
): PeerTrigger | null {
  const inflight = file.inflight;
  if (!inflight || inflight.secretaryConversationId !== conversationId) return null;
  const keys = new Set(inflight.keys);
  const peers = file.outbox.filter(
    (update): update is PeerUpdate =>
      update.kind === 'peer-message' && keys.has(update.key) && update.hop > 0
  );
  if (peers.length === 0) return null;
  const deepest = peers.reduce((best, update) => (update.hop > best.hop ? update : best));
  const origins = [...new Set(peers.flatMap((update) => update.origins))];
  return { chain: deepest.chain, hop: deepest.hop, origins };
}

export type PeerLink =
  | { ok: true; chain: string; hop: number; origins: string[] }
  | { ok: false; error: 'chain-limit' };

/** 下一跳：没有触发就开新链（第 1 跳），有就接着数；超过上限拒绝 */
export function nextPeerLink(
  trigger: PeerTrigger | null,
  self: string,
  newChain: () => string
): PeerLink {
  if (!trigger) return { ok: true, chain: newChain(), hop: 1, origins: [self] };
  const hop = trigger.hop + 1;
  if (hop > PEER_HOP_LIMIT) return { ok: false, error: 'chain-limit' };
  return {
    ok: true,
    chain: trigger.chain,
    hop,
    origins: [...new Set([...trigger.origins, self])],
  };
}

/** 限速只在内存里：重启清零可以接受，跳数上限才是防循环的主防线 */
export class PeerRateLimiter {
  private readonly sent: { from: string; to: string; at: number }[] = [];

  check(from: string, to: string, now: number): 'ok' | 'rate-limited' {
    this.prune(now);
    const pair = this.sent.filter(
      (entry) => entry.from === from && entry.to === to && now - entry.at < PEER_PAIR_WINDOW_MS
    ).length;
    const sender = this.sent.filter(
      (entry) => entry.from === from && now - entry.at < PEER_SENDER_WINDOW_MS
    ).length;
    return pair >= PEER_PAIR_LIMIT || sender >= PEER_SENDER_LIMIT ? 'rate-limited' : 'ok';
  }

  record(from: string, to: string, now: number): void {
    this.sent.push({ from, to, at: now });
  }

  private prune(now: number): void {
    const keep = this.sent.filter((entry) => now - entry.at < PEER_PAIR_WINDOW_MS);
    this.sent.splice(0, this.sent.length, ...keep);
  }
}

/** 可见项目取交集：降权回合里每个秘书的可见集合都要包含目标项目 */
export function intersectProjectSets(sets: readonly (readonly string[])[]): string[] {
  if (sets.length === 0) return [];
  const [first, ...rest] = sets;
  return first.filter((id) => rest.every((set) => set.includes(id)));
}
