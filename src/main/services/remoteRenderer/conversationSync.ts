import {
  applyConversationsPatch,
  type ConversationsPatch,
  diffConversations,
  isEmptyConversationsPatch,
  isEmptyConversationsStore,
  type SequencedConversationsPatch,
} from '@shared/conversationsPatch';
import { IPC_CHANNELS } from '@shared/types';
import { localMainContents } from '../renderers';
import { remoteSenders } from './senders';

export const CONVERSATIONS_KEY = 'enso-conversations';

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

type SenderLike = { id: number; once?: (event: 'destroyed', listener: () => void) => unknown };

function track(sender: SenderLike): void {
  if (watched.has(sender) || typeof sender.once !== 'function') return;
  watched.add(sender);
  sender.once('destroyed', () => ledgers.delete(sender.id));
}

/** 非空基线锁定（settings 重读不能重置账本）；空基线可被后续非空读纠正 */
export function noteConversationsRead(sender: SenderLike, value: unknown): void {
  const existing = ledgers.get(sender.id);
  if (existing && (!isEmptyConversationsStore(existing.base) || isEmptyConversationsStore(value))) {
    return;
  }
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

/**
 * renderer 整份写回：回放已确认的补丁得到它写这份值时看到的磁盘状态，
 * 只把差量合并进磁盘，再以新序号推给其他主界面。
 */
export function mergeConversationsWrite(
  sender: SenderLike,
  current: unknown,
  value: unknown,
  ackSeq = 0
): unknown {
  track(sender);
  if (isEmptyConversationsStore(value) && !isEmptyConversationsStore(current)) {
    console.warn('[conversations] 拒绝整表清空写入');
    return current;
  }
  if (value === undefined) {
    ledgers.set(sender.id, { base: undefined, pending: [] });
    return undefined;
  }
  const ledger = ledgers.get(sender.id) ?? { base: current, pending: [] };
  let expected = ledger.base;
  const pending: { seq: number; patch: ConversationsPatch }[] = [];
  for (const entry of ledger.pending) {
    if (entry.seq <= ackSeq) expected = applyConversationsPatch(expected, entry.patch);
    else pending.push(entry);
  }
  ledgers.set(sender.id, { base: value, pending });
  const local = diffConversations(expected, value);
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

/** Main 侧写入入口：把补丁并进磁盘值并推给所有主界面，返回应落盘的值 */
export function applyMainConversationsPatch(current: unknown, patch: ConversationsPatch): unknown {
  if (isEmptyConversationsPatch(patch)) return current;
  for (const peer of mainPeers()) pushTo(peer, patch);
  notifyMerged(patch);
  return applyConversationsPatch(current, patch);
}

/** 磁盘上的会话值被合并后通知（用户排队消息经写回抵达 Main 时补投） */
export function onConversationsMerged(listener: (patch: ConversationsPatch) => void): () => void {
  mergedListeners.add(listener);
  return () => mergedListeners.delete(listener);
}
