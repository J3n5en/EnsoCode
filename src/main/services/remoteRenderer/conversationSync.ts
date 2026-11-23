import {
  applyConversationsPatch,
  type ConversationsPatch,
  diffConversations,
  isConversationsStore,
  isEmptyConversationsPatch,
  removesAllConversations,
  type SequencedConversationsPatch,
} from '@shared/conversationsPatch';
import { IPC_CHANNELS } from '@shared/types/ipc';
import { localMainContents } from '../renderers';
import { remoteSenders } from './senders';

export const CONVERSATIONS_KEY = 'enso-conversations';

/** 远端整份设置不带会话表：它单独经 conversations:read 取（有缓存和增量），这里重复带要多下载近 1MB */
export function withoutConversations<T>(settings: T): T {
  if (!settings || typeof settings !== 'object' || !(CONVERSATIONS_KEY in settings))
    return settings;
  const { [CONVERSATIONS_KEY]: _omit, ...rest } = settings as Record<string, unknown>;
  return rest as T;
}

/**
 * 每个主界面一本账：它最近一次写回的值（或 conversations:read 时的磁盘值），
 * 以及已推给它、它还没确认应用的补丁。写回时先回放已确认的补丁再求差量，
 * 否则用旧值写回会把 Main 期间插入的行抹掉。
 */
interface PeerLedger {
  base: unknown;
  pending: { seq: number; patch: ConversationsPatch }[];
}

const ledgers = new Map<number, PeerLedger>();
const watched = new WeakSet<object>();
const mergedListeners = new Set<(patch: ConversationsPatch) => void>();
let patchSeq = 0;

interface Peer {
  id: number;
  send(patch: SequencedConversationsPatch): void;
}

function mainPeers(): Peer[] {
  const peers: Peer[] = [];
  const contents = localMainContents();
  if (contents) {
    peers.push({
      id: contents.id,
      send: (patch) => contents.send(IPC_CHANNELS.CONVERSATIONS_PATCH, patch),
    });
  }
  for (const sender of remoteSenders()) {
    if (sender.kind !== 'main') continue;
    peers.push({
      id: sender.id,
      send: (patch) => sender.send(IPC_CHANNELS.CONVERSATIONS_PATCH, patch),
    });
  }
  return peers;
}

type SenderLike = {
  id: number;
  once?: (event: 'destroyed', listener: () => void) => unknown;
  send?: (channel: string, ...args: unknown[]) => void;
};

function track(sender: SenderLike): void {
  if (watched.has(sender) || typeof sender.once !== 'function') return;
  watched.add(sender);
  sender.once('destroyed', () => ledgers.delete(sender.id));
}

/** 只在该 sender 还没有账本时建账：settings store 的重读频繁，不能重置会话账本 */
export function noteConversationsRead(sender: SenderLike, value: unknown): void {
  if (ledgers.has(sender.id)) return;
  track(sender);
  ledgers.set(sender.id, { base: value, pending: [] });
}

/** 主界面显式读会话：返回磁盘值与当前序号，并把账本重置为这份值 */
export function readConversationsFor(
  sender: SenderLike,
  current: unknown
): { value: unknown; seq: number } {
  track(sender);
  ledgers.set(sender.id, { base: current, pending: [] });
  return { value: current, seq: patchSeq };
}

/** 没有账本的 peer 不记 pending：它的写回以磁盘值为基线，本身就是正确的 */
function pushTo(peer: Peer, patch: ConversationsPatch): void {
  const seq = ++patchSeq;
  ledgers.get(peer.id)?.pending.push({ seq, patch });
  peer.send({ ...patch, seq });
}

function notifyMerged(patch: ConversationsPatch): void {
  for (const listener of mergedListeners) listener(patch);
}

/** 拒收写回：磁盘与账本都不动，让写回方按 conversations:read 重新水合，免得带着坏内存再写 */
function rejectWrite(sender: SenderLike, current: unknown, reason: string): unknown {
  console.warn(`[conversations] 拒绝${reason}写入`);
  sender.send?.(IPC_CHANNELS.CONVERSATIONS_RESYNC);
  return current;
}

/**
 * renderer 整份写回：回放已确认的补丁得到它写这份值时看到的磁盘状态，
 * 只把差量合并进磁盘，再以新序号推给其他主界面。
 * 差量会删光磁盘上现有的全部会话时拒收（用户明确删除走 Main 的删除入口，不经这里）。
 */
export function mergeConversationsWrite(
  sender: SenderLike,
  current: unknown,
  value: unknown,
  ackSeq = 0
): unknown {
  track(sender);
  if (value === undefined) {
    ledgers.set(sender.id, { base: undefined, pending: [] });
    return undefined;
  }
  if (!isConversationsStore(value)) return rejectWrite(sender, current, '结构不合法的');
  const ledger = ledgers.get(sender.id) ?? { base: current, pending: [] };
  let expected = ledger.base;
  const pending: { seq: number; patch: ConversationsPatch }[] = [];
  for (const entry of ledger.pending) {
    if (entry.seq <= ackSeq) expected = applyConversationsPatch(expected, entry.patch);
    else pending.push(entry);
  }
  const local = diffConversations(expected, value);
  if (removesAllConversations(current, local)) return rejectWrite(sender, current, '整表删除');
  ledgers.set(sender.id, { base: value, pending });
  const peers = mainPeers().filter((peer) => peer.id !== sender.id);
  const empty = isEmptyConversationsPatch(local);
  const merged = empty ? (current ?? value) : applyConversationsPatch(current, local);
  if (!empty) {
    for (const peer of peers) pushTo(peer, local);
    notifyMerged(local);
  }
  return peers.length === 0 ? withWriterFields(merged, value) : merged;
}

/**
 * 补丁只管会话行与 order。独占时 activeId、version 等其余字段仍以写回方为准（原整份覆盖语义）；
 * 多主界面时不让任何一端改磁盘上的 activeId。
 */
function withWriterFields(merged: unknown, value: unknown): unknown {
  const record = (v: unknown): Record<string, unknown> =>
    typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  const mergedState = record(record(merged).state);
  return {
    ...record(value),
    state: {
      ...record(record(value).state),
      conversations: mergedState.conversations,
      order: mergedState.order,
    },
  };
}

/** Main 侧写入入口：把补丁并进磁盘值并推给主界面（exceptId 是已有这份变化的发起方），返回应落盘的值 */
export function applyMainConversationsPatch(
  current: unknown,
  patch: ConversationsPatch,
  exceptId?: number
): unknown {
  if (isEmptyConversationsPatch(patch)) return current;
  for (const peer of mainPeers()) if (peer.id !== exceptId) pushTo(peer, patch);
  notifyMerged(patch);
  return applyConversationsPatch(current, patch);
}

/** 磁盘上的会话值被合并后通知（用户排队消息经写回抵达 Main 时补投） */
export function onConversationsMerged(listener: (patch: ConversationsPatch) => void): () => void {
  mergedListeners.add(listener);
  return () => mergedListeners.delete(listener);
}
