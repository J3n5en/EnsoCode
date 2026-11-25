import { EventEmitter } from 'node:events';
import { encodeRemoteValue, type HostToRemote, type RemoteKind } from '@enso/pair';
import { REREAD_MARK, RemoteWriteBases, UPSERT_MARK, UpsertEncoder } from '@shared/remoteDelta';
import {
  OVERVIEW_BYTE_BUDGET,
  OVERVIEW_TAIL_MESSAGES,
  takeSnapshotTail,
} from '@shared/snapshotTail';

/** 已发帧保留窗口：浏览器续上时从它确认的 seq 之后补发；超出窗口则续连失败，浏览器重载 renderer */
const MAX_RETAINED_FRAMES = 4000;
const MAX_RETAINED_BYTES = 8 * 1024 * 1024;
/** 已处理请求 id 的去重窗口 */
const MAX_SEEN_IDS = 8192;
/**
 * 流式正文合并窗口：worker 每 50ms 推一次整条消息，长回复的流量随长度平方增长，
 * 经中继/蜂窝很快排队。远端同一条消息只发窗口内最后一版（reducer 容许 seq 跳号）。
 */
export const STREAM_COALESCE_MS = 150;
const AGENT_EVENT_CHANNEL = 'agent:event';
/**
 * settings:changed 不带数据，远端收到即整份重读 settings（可达数百 KB）。
 * 桌面一轮对话会连写多次，合并成一次通知；晚到无妨，重读拿的总是最新。
 */
export const SETTINGS_COALESCE_MS = 400;
const SETTINGS_CHANGED_CHANNEL = 'settings:changed';
/**
 * 秘书整份状态可达数百 KB、对话时每 300ms 一份：主界面只收按秘书合并的重读通知，
 * 远端自行走缓存重读拿增量，免得整份状态堵在有序流上、后台期间塞满保留窗口。
 */
export const SECRETARY_COALESCE_MS = 400;
const SECRETARY_STATE_CHANNEL = 'secretary:state-changed';
/** 最近发出的 resume 尾窗（按会话），供紧随其后的 resume 全量快照比对 */
const MAX_RESUME_TAILS = 8;
/** 与真实 webContents id（小整数）错开 */
let nextId = 1_000_000_000;

type Deliver = (frame: HostToRemote) => void;

interface Retained {
  seq: number;
  frame: HostToRemote;
  bytes: number;
}

/**
 * 远程浏览器里一个 renderer 帧的「伪 WebContents」：handler 以 event.sender 用到的
 * id / send / isDestroyed / once('destroyed') 都在这里实现，宿主代码无需区分本地与远端。
 *
 * 链路可能在宿主察觉前就已断开（iOS 切后台），期间发出的帧会静默丢失，所以不能只在
 * suspend 之后才缓冲：每帧都编号并保留一段窗口，浏览器重连时报告已应用到哪个 seq。
 */
export class RemoteSender extends EventEmitter {
  readonly id = nextId++;
  /** 所属页面加载（旧版浏览器不报） */
  page?: string;
  private destroyed = false;
  private suspended = false;
  private seq = 0;
  /** suspend 时已发出的最后 seq：旧版浏览器不报 seq，按此补发 */
  private suspendedAfter = 0;
  private retained: Retained[] = [];
  private retainedBytes = 0;
  private evictedThrough = 0;
  private seen = new Set<number>();
  private seenFloor = 0;
  private readonly maxFrames: number;
  private readonly maxBytes: number;
  private streaming = new Map<string, unknown[]>();
  private streamTimer: NodeJS.Timeout | null = null;
  private settingsTimer: NodeJS.Timeout | null = null;
  private secretaryTimer: NodeJS.Timeout | null = null;
  private secretaryIds = new Set<string>();
  private upserts = new UpsertEncoder();
  private resumeTails = new Map<string, string>();
  /** 设置写入增量的宿主基线 */
  readonly writes = new RemoteWriteBases();

  constructor(
    readonly pairId: string,
    readonly cid: string,
    readonly kind: RemoteKind,
    private deliver: Deliver,
    limits: { maxFrames?: number; maxBytes?: number } = {}
  ) {
    super();
    this.setMaxListeners(0);
    this.maxFrames = limits.maxFrames ?? MAX_RETAINED_FRAMES;
    this.maxBytes = limits.maxBytes ?? MAX_RETAINED_BYTES;
  }

  send(channel: string, ...args: unknown[]): void {
    if (channel === SETTINGS_CHANGED_CHANNEL && args.length === 0) {
      if (this.destroyed) return;
      this.settingsTimer ??= setTimeout(() => {
        this.settingsTimer = null;
        this.post({ type: 'rpc-event', cid: this.cid, ch: channel, args: encodeRemoteValue([]) });
      }, SETTINGS_COALESCE_MS);
      return;
    }
    const secretaryId =
      channel === SECRETARY_STATE_CHANNEL && this.kind === 'main'
        ? (args[0] as { secretaryId?: unknown } | undefined)?.secretaryId
        : undefined;
    if (typeof secretaryId === 'string') {
      if (this.destroyed) return;
      this.secretaryIds.add(secretaryId);
      this.secretaryTimer ??= setTimeout(() => {
        this.secretaryTimer = null;
        const ids = [...this.secretaryIds];
        this.secretaryIds.clear();
        for (const id of ids) {
          this.post({
            type: 'rpc-event',
            cid: this.cid,
            ch: channel,
            args: encodeRemoteValue([{ [REREAD_MARK]: id }]),
          });
        }
      }, SECRETARY_COALESCE_MS);
      return;
    }
    if (channel === AGENT_EVENT_CHANNEL && isSnapshotEvent(args[0])) {
      const snapshot = this.dedupeResumeFull(trimSnapshot(args[0]));
      if (!snapshot) return;
      args = [snapshot, ...args.slice(1)];
    }
    const key = channel === AGENT_EVENT_CHANNEL ? streamKey(args[0]) : null;
    if (key === null) {
      this.post({ type: 'rpc-event', cid: this.cid, ch: channel, args: encodeRemoteValue(args) });
      return;
    }
    if (this.destroyed) return;
    // 删后重插：排到末尾，保证冲刷时各会话的 seq 仍递增
    this.streaming.delete(key);
    this.streaming.set(key, args);
    this.streamTimer ??= setTimeout(() => this.flushStreaming(), STREAM_COALESCE_MS);
  }

  /** 事件与调用结果同一出口：编号后保留，在线即投递。暂存的流式正文先发，不被后来的帧越过 */
  post(frame: HostToRemote): void {
    this.flushStreaming();
    this.postNow(frame);
  }

  private flushStreaming(): void {
    if (this.streamTimer) clearTimeout(this.streamTimer);
    this.streamTimer = null;
    if (this.streaming.size === 0) return;
    const pending = [...this.streaming];
    this.streaming.clear();
    for (const [key, args] of pending) {
      const encoded = encodeRemoteValue(args) as Record<string, unknown>[];
      const event = encoded[0] as Record<string, unknown>;
      const { mark, message } = this.upserts.encode(key, event.message);
      if (message === undefined) delete event.message;
      event[UPSERT_MARK] = mark;
      this.postNow({ type: 'rpc-event', cid: this.cid, ch: AGENT_EVENT_CHANNEL, args: encoded });
    }
  }

  /** 浏览器缺流式基线时调用：之后每条消息先发整条 */
  resetUpserts(): void {
    this.upserts.reset();
  }

  /**
   * resume 先发尾窗、紧接着发全量；远端会把全量也裁成尾窗，只要末条消息与其余字段相同，
   * 远端已有的尾窗就覆盖了全量裁剪后的内容（更早的由上滑分页按尾窗的 baseIndex 拉取）。
   * 只比对 worker 明确标记的 resume 全量与紧邻它之前的那份尾窗，普通快照一律送达。
   */
  private dedupeResumeFull(event: SnapshotEvent): SnapshotEvent | null {
    const sessionKey = (s: SnapshotEvent['sessions'][number]) =>
      typeof s.identity?.sessionId === 'string' ? s.identity.sessionId : null;
    if (!event.resumeFull) {
      if (event.partial) {
        for (const session of event.sessions) {
          const key = sessionKey(session);
          if (key) touchLimited(this.resumeTails, key, signature(session), MAX_RESUME_TAILS);
        }
      }
      return event;
    }
    const sessions = event.sessions.filter((session) => {
      const key = sessionKey(session);
      if (!key) return true;
      const tail = this.resumeTails.get(key);
      this.resumeTails.delete(key);
      return tail !== signature(session);
    });
    if (sessions.length === 0) return null;
    return sessions.length === event.sessions.length ? event : { ...event, sessions };
  }

  private postNow(frame: HostToRemote): void {
    if (this.destroyed) return;
    const stamped = { ...frame, seq: ++this.seq } as HostToRemote;
    const bytes = JSON.stringify(stamped).length;
    this.retained.push({ seq: this.seq, frame: stamped, bytes });
    this.retainedBytes += bytes;
    while (
      this.retained.length > 1 &&
      (this.retained.length > this.maxFrames || this.retainedBytes > this.maxBytes)
    ) {
      const evicted = this.retained.shift() as Retained;
      this.retainedBytes -= evicted.bytes;
      this.evictedThrough = evicted.seq;
    }
    if (!this.suspended) this.deliver(stamped);
  }

  get online(): boolean {
    return !this.destroyed && !this.suspended;
  }

  /** 断链后积压的帧字节数：溢出后旧帧会被丢，续连就只能重载 */
  get bufferedBytes(): number {
    return this.retainedBytes;
  }

  get bufferLimit(): number {
    return this.maxBytes;
  }

  suspend(): void {
    if (this.destroyed || this.suspended) return;
    this.suspended = true;
    this.suspendedAfter = this.seq;
  }

  /**
   * 续上新连接，从浏览器已应用的 seq 之后补发。
   * 所需帧已移出窗口，或浏览器声称收到过宿主没发过的帧，返回 false（调用方应销毁并让浏览器重载）。
   */
  /** beforeReplay 在确认能续上、补发之前调用：调用方借此先回 rpc-ready */
  resume(deliver: Deliver, appliedSeq?: number, beforeReplay?: () => void): boolean {
    this.deliver = deliver;
    const from = appliedSeq ?? (this.suspended ? this.suspendedAfter : this.seq);
    this.suspended = false;
    if (from < this.evictedThrough || from > this.seq) return false;
    beforeReplay?.();
    for (const { seq, frame } of this.retained) if (seq > from) deliver(frame);
    return true;
  }

  /** 请求 id 首次出现才处理；浏览器续上后会重发未决请求。无 id（旧版浏览器）不去重 */
  accept(id: number | undefined): boolean {
    if (id === undefined) return true;
    if (id <= this.seenFloor || this.seen.has(id)) return false;
    this.seen.add(id);
    if (this.seen.size > MAX_SEEN_IDS) {
      const oldest = this.seen.values().next().value as number;
      this.seen.delete(oldest);
      this.seenFloor = Math.max(this.seenFloor, oldest);
    }
    return true;
  }

  isDestroyed(): boolean {
    return this.destroyed;
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    if (this.streamTimer) clearTimeout(this.streamTimer);
    this.streamTimer = null;
    this.streaming.clear();
    this.resumeTails.clear();
    if (this.settingsTimer) clearTimeout(this.settingsTimer);
    this.settingsTimer = null;
    if (this.secretaryTimer) clearTimeout(this.secretaryTimer);
    this.secretaryTimer = null;
    this.secretaryIds.clear();
    this.retained = [];
    this.retainedBytes = 0;
    this.emit('destroyed');
    this.removeAllListeners();
  }

  isFocused(): boolean {
    return false;
  }

  getURL(): string {
    return `enso-remote://${this.pairId}/${this.kind}`;
  }

  getTitle(): string {
    return 'EnsoCode Remote';
  }

  getOSProcessId(): number {
    return -1;
  }
}

interface SnapshotEvent {
  type: 'snapshot';
  partial?: boolean;
  resumeFull?: boolean;
  sessionId?: string;
  sessions: {
    identity?: { sessionId?: unknown };
    messages: unknown[];
    baseIndex?: number;
    customEntries?: unknown[];
  }[];
}

/** 顶层字段顺序无关（尾窗的 baseIndex 位置与裁剪后的全量不同） */
/** 末条消息 + 除 messages/baseIndex 外的字段（顶层顺序无关） */
const signature = (session: { messages: unknown[] }): string =>
  JSON.stringify([
    session.messages.at(-1) ?? null,
    Object.entries(session)
      .filter(([key]) => key !== 'messages' && key !== 'baseIndex')
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
  ]);

function touchLimited(map: Map<string, string>, key: string, value: string, cap: number): void {
  map.delete(key);
  map.set(key, value);
  while (map.size > cap) map.delete(map.keys().next().value as string);
}

function isSnapshotEvent(event: unknown): event is SnapshotEvent {
  const e = event as Partial<SnapshotEvent> | null;
  return (
    !!e &&
    e.type === 'snapshot' &&
    Array.isArray(e.sessions) &&
    e.sessions.every((s) => s && Array.isArray(s.messages))
  );
}

/**
 * 远端只要尾窗：worker 的全量/resume 快照带整段历史（长会话可达数十 MB），经中继要几十秒，
 * 且按 seq 顺序应用会把后面的消息全部堵住。更早的历史由远端上滑分页按需拉取（与手机版一致）。
 * 全量概览（非 partial，启动时要一次）含 worker 持有的所有会话，只给最近几条：
 * 打开会话时另要定向快照取完整尾窗，reducer 按 baseIndex 保留本地已有的前缀。
 */
/** 尾窗消息里的工具调用 id */
function toolCallIds(messages: unknown[]): Set<string> {
  const ids = new Set<string>();
  for (const message of messages) {
    const content = (message as { content?: unknown } | null)?.content;
    if (!Array.isArray(content)) continue;
    for (const part of content as { type?: unknown; id?: unknown }[]) {
      if (part?.type === 'toolCall' && typeof part.id === 'string') ids.add(part.id);
    }
  }
  return ids;
}

/** 工具批次标签每批一条、随会话无限增长（长会话数百 KB）：只留尾窗里用得上的 */
function trimBatchLabels(entries: unknown[], messages: unknown[]): unknown[] {
  const ids = toolCallIds(messages);
  return entries.filter((entry) => {
    const e = entry as { kind?: unknown; callId?: unknown } | null;
    return e?.kind !== 'tool-batch-label' || (typeof e.callId === 'string' && ids.has(e.callId));
  });
}

function trimSnapshot(event: SnapshotEvent): SnapshotEvent {
  const limits = event.partial
    ? {}
    : { messages: OVERVIEW_TAIL_MESSAGES, bytes: OVERVIEW_BYTE_BUDGET };
  return {
    ...event,
    sessions: event.sessions.map((session) => {
      const tail = takeSnapshotTail(session.messages, session.messages.length, limits);
      if (tail.baseIndex === 0) return session;
      return {
        ...session,
        messages: tail.messages,
        baseIndex: (session.baseIndex ?? 0) + tail.baseIndex,
        ...(session.customEntries
          ? { customEntries: trimBatchLabels(session.customEntries, tail.messages) }
          : {}),
      };
    }),
  };
}

/** 可合并的流式正文：同一会话实例同一条消息的 message-upsert */
function streamKey(event: unknown): string | null {
  if (!event || typeof event !== 'object') return null;
  const e = event as {
    type?: unknown;
    index?: unknown;
    identity?: { sessionId?: unknown; generation?: unknown; instanceId?: unknown };
  };
  if (e.type !== 'message-upsert' || typeof e.index !== 'number') return null;
  const id = e.identity;
  if (!id || typeof id.sessionId !== 'string') return null;
  return `${id.sessionId}\0${String(id.instanceId ?? '')}\0${String(id.generation ?? '')}\0${e.index}`;
}

const byKey = new Map<string, RemoteSender>();
const byId = new Map<number, RemoteSender>();

const keyOf = (pairId: string, cid: string) => `${pairId}\u0000${cid}`;

export function addRemoteSender(sender: RemoteSender): void {
  byKey.set(keyOf(sender.pairId, sender.cid), sender);
  byId.set(sender.id, sender);
  sender.once('destroyed', () => {
    if (byKey.get(keyOf(sender.pairId, sender.cid)) === sender) {
      byKey.delete(keyOf(sender.pairId, sender.cid));
    }
    byId.delete(sender.id);
  });
}

export function getRemoteSender(pairId: string, cid: string): RemoteSender | undefined {
  return byKey.get(keyOf(pairId, cid));
}

export function remoteSenderById(id: number): RemoteSender | undefined {
  return byId.get(id);
}

export function remoteSenders(pairId?: string): RemoteSender[] {
  const all = [...byId.values()];
  return pairId === undefined ? all : all.filter((s) => s.pairId === pairId);
}

/**
 * 同一设备旧页面遗留的 renderer：中继每个配对只容一个手机连接，新页面接入即说明旧页面已死。
 * 旧页面卸载时不一定来得及发 rpc-bye，留着它会一直占用链路接收全部广播。
 */
export function staleRemoteSenders(pairId: string, page: string | undefined): RemoteSender[] {
  if (page === undefined) return [];
  return remoteSenders(pairId).filter((s) => s.page !== undefined && s.page !== page);
}

export const isRemoteMainSender = (id: number): boolean => byId.get(id)?.kind === 'main';
export const hasRemoteMain = (): boolean =>
  [...byId.values()].some((sender) => sender.kind === 'main');

/**
 * 远端主界面接入/续连后补发各秘书的重读通知。
 * 重读标记是一次性事件：帧被丢（断链重连途中 sender 重建、合并窗口被覆盖等）后，
 * 远端要等下一次状态变化才会重拉，期间提案卡一直停在占位行、没有确认按钮。
 * 接入时无条件补一遍，远端按缓存增量重读，未变时几乎零成本。
 * settings 窗口不能收半成品状态（它会把 { secretaryId } 当整份原样推出去），只 prime 主界面。
 */
export function primeSecretaryRereads(sender: RemoteSender, secretaryIds: readonly string[]): void {
  if (sender.kind !== 'main') return;
  for (const id of secretaryIds) {
    sender.send(SECRETARY_STATE_CHANNEL, { secretaryId: id });
  }
}

/** 广播给所有远端 renderer（exceptId 用于排除发起方，语义同桌面多窗口广播） */
export function sendToRemoteRenderers(
  channel: string,
  args: unknown[],
  exceptId?: number,
  exceptKind?: RemoteKind
): void {
  for (const sender of byId.values()) {
    if (sender.id !== exceptId && sender.kind !== exceptKind) sender.send(channel, ...args);
  }
}

/** 桌面主窗口在则它是 leader；否则最早接入的远端主界面 */
export function remoteLeaderId(desktopMainAlive: boolean): number | null {
  if (desktopMainAlive) return null;
  let leader: RemoteSender | null = null;
  for (const sender of byId.values()) {
    // 挂起的页面收不到事件，不能继续当 leader
    if (sender.kind !== 'main' || !sender.online) continue;
    if (!leader || sender.id < leader.id) leader = sender;
  }
  return leader?.id ?? null;
}
