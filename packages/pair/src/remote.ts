/**
 * 远程桌面隧道：浏览器里运行桌面 renderer，经配对加密通道调用 Main 的 IPC。
 * 帧走 PhoneToHost / HostToPhone 同一信道；超出中继单帧上限的消息切成 part / bpart。
 */

import {
  concatBytes,
  defaultFrameCodec,
  type FrameCodec,
  isIncompressibleMime,
  MAX_DECOMPRESSED_BYTES,
  packBinaryEnvelope,
  unpackBinaryEnvelope,
} from './crypto';

export type RemoteKind = 'main' | 'settings';

export interface RemotePrefetchItem {
  ch: string;
  args: unknown[];
  h: string;
}

export interface RemotePrefetchResultItem {
  ch: string;
  args: unknown[];
  data: unknown;
}

export interface RemotePrefetchResult {
  type: 'rpc-prefetch';
  cid: string;
  items: RemotePrefetchResultItem[];
}

export type RemoteToHost =
  /** seq：已按序应用的最后一个宿主帧序号，宿主据此补发 */
  /** page：每次页面加载一个；宿主据此回收旧页面遗留的 renderer */
  | {
      type: 'rpc-hello';
      cid: string;
      kind: RemoteKind;
      seq?: number;
      page?: string;
      prefetch?: RemotePrefetchItem[];
    }
  | { type: 'rpc-bye'; cid: string }
  | { type: 'rpc-invoke'; cid: string; id: number; ch: string; args: unknown }
  /** id：续上后可能重发，宿主按 id 去重 */
  | { type: 'rpc-send'; cid: string; id?: number; ch: string; args: unknown }
  | { type: 'asset-get'; id: number; path: string }
  /** 本页累计收到的分片字节：宿主据此限制在途的大帧数据（流控）；gzip：能解压大帧；v2：支持二进制加密帧 */
  | { type: 'remote-ack'; bytes: number; gzip?: true; v2?: true }
  | RemotePart
  | RemoteBinaryPart;

export type HostToRemote =
  | {
      type: 'rpc-ready';
      cid: string;
      ok: true;
      resumed: boolean;
      version: string;
      platform: string;
      leader: boolean;
      /** 宿主按 seq 补发并对 invoke/send 去重：浏览器可放心重发未决请求 */
      replay?: true;
      /** 宿主接受 rpc-hello.prefetch，将并发推送一帧 rpc-prefetch */
      prefetch?: true;
    }
  | { type: 'rpc-ready'; cid: string; ok: false; error: string }
  | { type: 'rpc-result'; cid: string; id: number; ok: true; data: unknown; seq?: number }
  | { type: 'rpc-result'; cid: string; id: number; ok: false; error: string; seq?: number }
  | { type: 'rpc-event'; cid: string; ch: string; args: unknown; seq?: number }
  | { type: 'asset'; id: number; status: number; mime: string; data?: string; bin?: Uint8Array }
  | RemoteGzip
  | RemotePart
  | RemoteBinaryPart
  | RemoteBatch
  | RemotePrefetchResult;

/** 断线补发与并发流式冲洗批封套：多条连续 rpc 帧合成一帧，共用一次 gzip 字典与加解密 */
export interface RemoteBatch {
  type: 'rpc-batch';
  frames: (
    | { type: 'rpc-result'; cid: string; id: number; ok: true; data: unknown; seq?: number }
    | { type: 'rpc-result'; cid: string; id: number; ok: false; error: string; seq?: number }
    | { type: 'rpc-event'; cid: string; ch: string; args: unknown; seq?: number }
  )[];
}

/** 大帧压缩：原帧 JSON 经 gzip 后 base64，解开后按普通帧处理 */
export interface RemoteGzip {
  type: 'gzip';
  data: string;
}

export interface RemotePart {
  type: 'part';
  pid: string;
  index: number;
  total: number;
  data: string;
}

export interface RemoteBinaryPart {
  type: 'bpart';
  pid: string;
  index: number;
  total: number;
  enc: 'json' | 'bin';
  gz?: true;
  bin: Uint8Array;
}

/** 每片最多字符数：UTF-8 最坏 3 字节/字符，加密封装后仍低于中继 1MB 单帧上限 */
export const REMOTE_PART_CHARS = 240_000;
/** v2 二进制分片每片最大原始字节数：留足头字段与加密开销，远低于中继 1MB 单帧上限 */
export const REMOTE_BIN_PART_BYTES = 700_000;
/** 单批 rpc-batch 上限：控制在 256KB 与 256 条内，让首批重放帧快速解密上屏 */
export const REMOTE_BATCH_MAX_BYTES = 256 * 1024;
export const REMOTE_BATCH_MAX_FRAMES = 256;
const MAX_PARTS = 1024;

const TAG = '$enso';

function toBase64(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}

function fromBase64(text: string): Uint8Array {
  const bin = atob(text);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export const encodeBase64 = toBase64;
export const decodeBase64 = fromBase64;

function encode(value: unknown, seen: WeakSet<object>, slot: boolean): unknown {
  if (value === undefined) return slot ? { [TAG]: 'undef' } : undefined;
  if (typeof value === 'bigint') return { [TAG]: 'big', v: value.toString() };
  if (typeof value === 'number' && !Number.isFinite(value))
    return { [TAG]: 'num', v: String(value) };
  if (value === null || typeof value !== 'object') {
    return typeof value === 'function' || typeof value === 'symbol' ? undefined : value;
  }
  if (ArrayBuffer.isView(value)) {
    return {
      [TAG]: 'u8',
      v: toBase64(new Uint8Array(value.buffer, value.byteOffset, value.byteLength)),
    };
  }
  if (value instanceof ArrayBuffer) return { [TAG]: 'u8', v: toBase64(new Uint8Array(value)) };
  if (value instanceof Date) return { [TAG]: 'date', v: value.getTime() };
  if (value instanceof Error) {
    return { [TAG]: 'err', name: value.name, message: value.message };
  }
  if (seen.has(value)) return null;
  seen.add(value);
  try {
    if (value instanceof Map) {
      return {
        [TAG]: 'map',
        v: [...value].map(([k, v]) => [encode(k, seen, true), encode(v, seen, true)]),
      };
    }
    if (value instanceof Set) {
      return { [TAG]: 'set', v: [...value].map((v) => encode(v, seen, true)) };
    }
    if (Array.isArray(value)) return value.map((v) => encode(v, seen, true));
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      const encoded = encode(v, seen, false);
      if (encoded !== undefined) out[k] = encoded;
    }
    return out;
  } finally {
    seen.delete(value);
  }
}

function decode(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(decode);
  const record = value as Record<string, unknown>;
  switch (record[TAG]) {
    case 'u8':
      return typeof record.v === 'string' ? fromBase64(record.v) : new Uint8Array();
    case 'map':
      return new Map(
        (Array.isArray(record.v) ? record.v : []).map((pair) => {
          const [k, v] = Array.isArray(pair) ? pair : [];
          return [decode(k), decode(v)] as const;
        })
      );
    case 'set':
      return new Set((Array.isArray(record.v) ? record.v : []).map(decode));
    case 'date':
      return new Date(Number(record.v));
    case 'big':
      return BigInt(String(record.v));
    case 'num':
      return Number(record.v);
    case 'undef':
      return undefined;
    case 'err': {
      const error = new Error(String(record.message ?? ''));
      error.name = String(record.name ?? 'Error');
      return error;
    }
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(record)) {
    if (k === '__proto__') continue;
    out[k] = decode(v);
  }
  return out;
}

/** 结构化克隆语义 → JSON 安全值（补回 Uint8Array/Map/Set/Date/BigInt/数组里的 undefined） */
export function encodeRemoteValue(value: unknown): unknown {
  return encode(value, new WeakSet(), true);
}

export function decodeRemoteValue<T = unknown>(value: unknown): T {
  return decode(value) as T;
}

/** 序列化后超过单片上限则切片；否则原样返回单元素数组 */
export function splitRemoteFrame<T extends { type: string }>(
  message: T,
  pid: () => string,
  limit = REMOTE_PART_CHARS
): (T | RemotePart)[] {
  const text = JSON.stringify(message);
  if (text.length <= limit) return [message];
  const total = Math.ceil(text.length / limit);
  if (total > MAX_PARTS) throw new Error(`remote frame too large: ${text.length} chars`);
  const id = pid();
  return Array.from({ length: total }, (_, index) => ({
    type: 'part' as const,
    pid: id,
    index,
    total,
    data: text.slice(index * limit, (index + 1) * limit),
  }));
}

export function isRemotePart(value: unknown): value is RemotePart {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    v.type === 'part' &&
    typeof v.pid === 'string' &&
    v.pid.length > 0 &&
    v.pid.length <= 64 &&
    Number.isInteger(v.index) &&
    Number.isInteger(v.total) &&
    (v.total as number) > 0 &&
    (v.total as number) <= MAX_PARTS &&
    (v.index as number) >= 0 &&
    (v.index as number) < (v.total as number) &&
    typeof v.data === 'string' &&
    v.data.length <= REMOTE_PART_CHARS
  );
}

export function isRemoteBinaryPart(
  value: unknown,
  maxBytes = REMOTE_BIN_PART_BYTES
): value is RemoteBinaryPart {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    v.type === 'bpart' &&
    typeof v.pid === 'string' &&
    v.pid.length > 0 &&
    v.pid.length <= 64 &&
    Number.isInteger(v.index) &&
    Number.isInteger(v.total) &&
    (v.total as number) > 0 &&
    (v.total as number) <= MAX_PARTS &&
    (v.index as number) >= 0 &&
    (v.index as number) < (v.total as number) &&
    (v.enc === 'json' || v.enc === 'bin') &&
    (v.gz === undefined || v.gz === true) &&
    v.bin instanceof Uint8Array &&
    v.bin.byteLength <= maxBytes
  );
}

const HOST_REMOTE_TYPES: ReadonlySet<string> = new Set([
  'rpc-ready',
  'rpc-result',
  'rpc-event',
  'asset',
  'gzip',
  'part',
  'bpart',
  'rpc-batch',
  'rpc-prefetch',
]);

type BatchableFrame = RemoteBatch['frames'][number];

function isBatchableFrame(frame: HostToRemote): frame is BatchableFrame {
  return frame.type === 'rpc-event' || frame.type === 'rpc-result';
}

/**
 * 将连续的 rpc-event / rpc-result 合并为 rpc-batch：
 * - 单条不套壳；>= 2 条合为 rpc-batch
 * - 超出 maxBytes / maxFrames 时自动切批；超大单条与非 rpc 帧保序单独输出
 */
export function batchRemoteFrames(
  entries: readonly { frame: HostToRemote; bytes: number }[],
  maxBytes = REMOTE_BATCH_MAX_BYTES,
  maxFrames = REMOTE_BATCH_MAX_FRAMES
): HostToRemote[] {
  const out: HostToRemote[] = [];
  let current: BatchableFrame[] = [];
  let currentBytes = 0;

  const flush = (): void => {
    if (current.length === 0) return;
    out.push(
      current.length === 1 ? (current[0] as HostToRemote) : { type: 'rpc-batch', frames: current }
    );
    current = [];
    currentBytes = 0;
  };

  for (const entry of entries) {
    if (!isBatchableFrame(entry.frame)) {
      flush();
      out.push(entry.frame);
      continue;
    }
    if (entry.bytes > maxBytes) {
      flush();
      out.push(entry.frame);
      continue;
    }
    if (
      current.length > 0 &&
      (current.length >= maxFrames || currentBytes + entry.bytes > maxBytes)
    ) {
      flush();
    }
    current.push(entry.frame);
    currentBytes += entry.bytes;
  }

  flush();
  return out;
}

export function isHostRemoteFrame(value: { type: string }): value is HostToRemote {
  return HOST_REMOTE_TYPES.has(value.type);
}

/** 超过这个长度才压缩：小帧压缩省不了多少，还多一次异步 */
export const REMOTE_GZIP_MIN_CHARS = 16 * 1024;

async function pipeBytes(
  bytes: Uint8Array,
  transform: CompressionStream | DecompressionStream
): Promise<Uint8Array> {
  const stream = new Blob([bytes as Uint8Array<ArrayBuffer>]).stream().pipeThrough(transform);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export async function gzipRemoteJson(json: string): Promise<RemoteGzip> {
  const packed = await pipeBytes(new TextEncoder().encode(json), new CompressionStream('gzip'));
  return { type: 'gzip', data: toBase64(packed) };
}

/** 解不开返回 null（坏数据只丢这一帧） */
export async function gunzipRemoteFrame(frame: RemoteGzip): Promise<unknown | null> {
  try {
    const bytes = await pipeBytes(fromBase64(frame.data), new DecompressionStream('gzip'));
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return null;
  }
}

export interface RemotePartAssembler {
  /** 收齐返回解析后的原消息；未齐或非法返回 null */
  push(part: RemotePart): unknown | null;
  clear(): void;
}

export function createRemotePartAssembler(
  opts: { ttlMs?: number; maxPending?: number; now?: () => number } = {}
): RemotePartAssembler {
  const ttlMs = opts.ttlMs ?? 120_000;
  const maxPending = opts.maxPending ?? 16;
  const now = opts.now ?? Date.now;
  const pending = new Map<string, { total: number; parts: string[]; got: number; at: number }>();
  const sweep = (): void => {
    const t = now();
    for (const [pid, entry] of pending) if (t - entry.at > ttlMs) pending.delete(pid);
  };
  return {
    push(part) {
      sweep();
      let entry = pending.get(part.pid);
      if (entry && entry.total !== part.total) {
        pending.delete(part.pid);
        return null;
      }
      if (!entry) {
        if (pending.size >= maxPending) {
          const oldest = pending.keys().next().value;
          if (oldest !== undefined) pending.delete(oldest);
        }
        entry = { total: part.total, parts: new Array(part.total), got: 0, at: now() };
        pending.set(part.pid, entry);
      }
      if (entry.parts[part.index] === undefined) {
        entry.parts[part.index] = part.data;
        entry.got++;
      }
      entry.at = now();
      if (entry.got < entry.total) return null;
      pending.delete(part.pid);
      try {
        return JSON.parse(entry.parts.join(''));
      } catch {
        return null;
      }
    },
    clear() {
      pending.clear();
    },
  };
}

/**
 * v2 二进制切片：超限前先把整帧（必要时原生 gzip）打成连续二进制载荷，
 * 再切成 <= limit 字节的 `bpart`（零 Base64）。未超限则返回原消息，交由 sealFrameV2 一次压缩加密。
 */
export async function splitRemoteBinaryFrame<T extends { type: string }>(
  message: T,
  pid: () => string,
  opts: { codec?: FrameCodec; limit?: number } = {}
): Promise<(T | RemoteBinaryPart)[]> {
  const limit = opts.limit ?? REMOTE_BIN_PART_BYTES;
  const { isBinary, bytes, headType, mime } = packBinaryEnvelope(message);
  if (bytes.byteLength <= limit) return [message];

  const enc: 'json' | 'bin' = isBinary ? 'bin' : 'json';
  let payload = bytes;
  let gz: true | undefined;

  const codec = opts.codec ?? defaultFrameCodec;
  const skipGzip = (headType === 'asset' || isBinary) && isIncompressibleMime(mime);
  if (!skipGzip && (opts.codec !== undefined || typeof CompressionStream === 'function')) {
    try {
      const packed = await codec.gzip(payload);
      if (packed.byteLength < payload.byteLength) {
        payload = packed;
        gz = true;
      }
    } catch {
      // 压缩失败则按未压缩切片
    }
  }

  const total = Math.max(1, Math.ceil(payload.byteLength / limit));
  if (total > MAX_PARTS) throw new Error(`remote binary frame too large: ${payload.byteLength}B`);
  const id = pid();
  return Array.from({ length: total }, (_, index) => ({
    type: 'bpart' as const,
    pid: id,
    index,
    total,
    enc,
    ...(gz ? { gz } : {}),
    bin: payload.subarray(index * limit, (index + 1) * limit),
  }));
}

export interface RemoteBinaryPartAssembler {
  /** 收齐并解包（含必要时的 gunzip）；未齐或非法返回 null */
  push(part: RemoteBinaryPart): Promise<unknown | null>;
  clear(): void;
}

export function createRemoteBinaryPartAssembler(
  opts: { ttlMs?: number; maxPending?: number; now?: () => number; codec?: FrameCodec } = {}
): RemoteBinaryPartAssembler {
  const ttlMs = opts.ttlMs ?? 120_000;
  const maxPending = opts.maxPending ?? 16;
  const now = opts.now ?? Date.now;
  const codec = opts.codec ?? defaultFrameCodec;
  const pending = new Map<
    string,
    {
      total: number;
      enc: 'json' | 'bin';
      gz: boolean;
      parts: (Uint8Array | undefined)[];
      got: number;
      bytes: number;
      at: number;
    }
  >();
  const sweep = (): void => {
    const t = now();
    for (const [pid, entry] of pending) if (t - entry.at > ttlMs) pending.delete(pid);
  };
  return {
    async push(part) {
      sweep();
      const gz = part.gz === true;
      let entry = pending.get(part.pid);
      if (entry && (entry.total !== part.total || entry.enc !== part.enc || entry.gz !== gz)) {
        pending.delete(part.pid);
        return null;
      }
      if (!entry) {
        if (pending.size >= maxPending) {
          const oldest = pending.keys().next().value;
          if (oldest !== undefined) pending.delete(oldest);
        }
        entry = {
          total: part.total,
          enc: part.enc,
          gz,
          parts: new Array<Uint8Array | undefined>(part.total),
          got: 0,
          bytes: 0,
          at: now(),
        };
        pending.set(part.pid, entry);
      }
      if (entry.parts[part.index] === undefined) {
        if (entry.bytes + part.bin.byteLength > MAX_DECOMPRESSED_BYTES) {
          pending.delete(part.pid);
          return null;
        }
        entry.parts[part.index] = part.bin;
        entry.bytes += part.bin.byteLength;
        entry.got++;
      }
      entry.at = now();
      if (entry.got < entry.total) return null;
      pending.delete(part.pid);
      const chunks = entry.parts.filter((chunk): chunk is Uint8Array => chunk !== undefined);
      if (chunks.length !== entry.total) return null;
      let raw = concatBytes(chunks, entry.bytes);
      try {
        if (entry.gz) raw = await codec.gunzip(raw);
        if (entry.enc === 'bin') return unpackBinaryEnvelope(raw);
        return JSON.parse(new TextDecoder().decode(raw));
      } catch {
        return null;
      }
    },
    clear() {
      pending.clear();
    },
  };
}

/**
 * 宿主帧按 seq 顺序应用。大帧走中继、小帧走直连，到达顺序不保证；
 * 续上后宿主从 applied 之后补发，重复帧在此丢弃。缺 seq（旧宿主）直接放行。
 */
export function createRemoteOrderedStream<T>(options: { maxHeld?: number } = {}) {
  const maxHeld = options.maxHeld ?? 4096;
  const held = new Map<number, T>();
  let applied = 0;
  let overflowed = false;
  return {
    push(seq: number | undefined, item: T): T[] {
      if (seq === undefined) return [item];
      if (seq <= applied || held.has(seq)) return [];
      held.set(seq, item);
      if (held.size > maxHeld) overflowed = true;
      const ready: T[] = [];
      for (let next = held.get(applied + 1); next !== undefined; next = held.get(applied + 1)) {
        held.delete(applied + 1);
        applied++;
        ready.push(next);
      }
      return ready;
    },
    get applied() {
      return applied;
    },
    get gap() {
      return held.size > 0;
    },
    get overflowed() {
      return overflowed;
    },
  };
}
