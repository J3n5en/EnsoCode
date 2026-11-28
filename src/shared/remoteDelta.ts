/**
 * 远程桌面经中继的增量协议（浏览器 shim 与宿主同一构建，标记对壳页面透明）：
 * - 设置写入：shim 记住上次成功写入的值，之后只上传差异；宿主基线不符时报 stale，shim 改发整份。
 * - 只读结果：shim 带上已缓存版本的 hash，宿主未变回 same，变了且认得旧版本则回增量。
 * - 流式消息：同一条 message-upsert 只发与上一帧的差异；接收端缺基线时请求 reset 并重拉快照。
 */
import { applyJsonDelta, diffJson, type JsonOp } from './jsonDelta';
import { IPC_CHANNELS } from './types/ipc';

export const REMOTE_DELTA_STALE = 'remote-delta-stale';
const WRITE = '__ensoWrite';
const IF_NONE = '__ensoIfNone';
const CACHED = '__ensoCached';
const UPSERT_RESET = '__ensoUpsertReset';
export const UPSERT_MARK = '__ensoUpsert';
/** 事件只带标识：远端据此走缓存重读（宿主回 same/增量），不必每次接收整份大状态 */
export const REREAD_MARK = '__ensoReread';

const DELTA_RATIO = 0.5;
const UPSERT_BASES = 32;
/** 历史尾窗等读取会挤占条数：太小时回前台读设置找不到基线，只能整份重发 */
const READ_CACHE_ENTRIES = 64;
const READ_CACHE_CHARS = 16 * 1024 * 1024;
const CLIENT_CACHE_CHARS = 8 * 1024 * 1024;

function markOf<T>(value: unknown, key: string): T | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const keys = Object.keys(value);
  if (keys.length !== 1 || keys[0] !== key) return undefined;
  return (value as Record<string, unknown>)[key] as T;
}

const worth = (ops: JsonOp[], fullChars: number) =>
  JSON.stringify(ops).length < fullChars * DELTA_RATIO;

function touch<V>(map: Map<string, V>, key: string, value: V, cap: number): void {
  map.delete(key);
  map.set(key, value);
  while (map.size > cap) map.delete(map.keys().next().value as string);
}

const staleError = () => new Error(REMOTE_DELTA_STALE);
const isStale = (error: unknown) =>
  String((error as Error | undefined)?.message ?? error).includes(REMOTE_DELTA_STALE);

/**
 * 读回结果同时是某个写入键的当前值：两端都拿它当写入基线，读完后的首次写回也只发差异。
 * 基线版本取内容 hash（负数，与写入递增的版本错开）：并发读写换序导致两端基线不同时宿主报 stale，客户端改发整份。
 */
export function writeSeedOf(
  channel: string,
  encodedResult: unknown
): { name: string; value: unknown } | null {
  if (channel !== IPC_CHANNELS.CONVERSATIONS_READ) return null;
  if (!encodedResult || typeof encodedResult !== 'object' || !('value' in encodedResult))
    return null;
  const value = (encodedResult as { value: unknown }).value;
  return value === undefined ? null : { name: 'enso-conversations', value };
}

const fnv = (h: number, str: string): number => {
  for (let i = 0; i < str.length; i++) h = Math.imul(h ^ str.charCodeAt(i), 0x01000193);
  return h;
};

const hasSerializableValue = (value: unknown): boolean => {
  if (value === undefined || typeof value === 'function' || typeof value === 'symbol') {
    return false;
  }
  if (Array.isArray(value)) return true;
  if (value && typeof value === 'object') {
    if (typeof (value as { toJSON?: unknown }).toJSON === 'function') {
      return JSON.stringify(value) !== undefined;
    }
    return true;
  }
  return JSON.stringify(value) !== undefined;
};

/** 流式计算对象键排序后的 FNV-1a 哈希：两端内容相同但键顺序不同时结果一致，避免兆级字符串拼接 */
function hashCanonical(value: unknown, h: number): number {
  if (Array.isArray(value)) {
    h = fnv(h, '[');
    for (let i = 0; i < value.length; i++) {
      if (i > 0) h = fnv(h, ',');
      const item = value[i];
      h = hasSerializableValue(item) ? hashCanonical(item, h) : fnv(h, 'null');
    }
    return fnv(h, ']');
  }
  if (
    value &&
    typeof value === 'object' &&
    typeof (value as { toJSON?: unknown }).toJSON !== 'function'
  ) {
    const record = value as Record<string, unknown>;
    h = fnv(h, '{');
    let first = true;
    for (const key of Object.keys(record).sort()) {
      const prop = record[key];
      if (!hasSerializableValue(prop)) continue;
      if (!first) h = fnv(h, ',');
      first = false;
      h = fnv(h, JSON.stringify(key));
      h = fnv(h, ':');
      h = hashCanonical(prop, h);
    }
    return fnv(h, '}');
  }
  return fnv(h, JSON.stringify(value) ?? '');
}

function seedRevision(value: unknown): number {
  const h = hashCanonical(value, 0x811c9dc5);
  return -1 - (h >>> 0) * 1024;
}

interface WriteMark {
  r: number;
  b?: number;
  ops?: JsonOp[];
  v?: unknown;
}

interface LazyWriteBase {
  r: number | null;
  v?: unknown;
  load?: () => unknown;
}

function materializeBase(entry: LazyWriteBase): { r: number; v: unknown } {
  if (entry.r === null) {
    const loaded = entry.load ? entry.load() : entry.v;
    entry.v = loaded;
    entry.r = seedRevision(loaded);
    entry.load = undefined;
  }
  return { r: entry.r, v: entry.v };
}

/** shim 侧：value 须是 JSON 安全的编码值且归调用方所有 */
export class RemoteWriteClient {
  private bases = new Map<string, LazyWriteBase>();
  private chains = new Map<string, Promise<unknown>>();

  /** 有写入在途时不动：在途写入完成后的基线才与宿主一致；hash 推迟到首次写入才算 */
  seed(name: string, value: unknown): void {
    if (this.chains.has(name)) return;
    this.bases.set(name, { r: null, v: value });
  }

  /** 只在真正发生写入时才反序列化/克隆基线并算 hash，启动读零开销 */
  seedLazy(name: string, load: () => unknown): void {
    if (this.chains.has(name)) return;
    this.bases.set(name, { r: null, load });
  }

  write(name: string, value: unknown, send: (arg: unknown) => Promise<unknown>): Promise<unknown> {
    const run = () => this.run(name, value, send);
    const result = (this.chains.get(name) ?? Promise.resolve()).then(run, run);
    const settled = result.catch(() => undefined);
    this.chains.set(name, settled);
    void settled.then(() => {
      if (this.chains.get(name) === settled) this.chains.delete(name);
    });
    return result;
  }

  private async run(name: string, value: unknown, send: (arg: unknown) => Promise<unknown>) {
    if (value === undefined) {
      this.bases.delete(name);
      return send(undefined);
    }
    const rawBase = this.bases.get(name);
    const base = rawBase ? materializeBase(rawBase) : undefined;
    const r = (base?.r ?? 0) + 1;
    if (base) {
      const ops = diffJson(base.v, value);
      if (ops.length === 0) return true;
      if (worth(ops, JSON.stringify(value).length)) {
        try {
          const result = await send({ [WRITE]: { r, b: base.r, ops } satisfies WriteMark });
          this.bases.set(name, { r, v: value });
          return result;
        } catch (error) {
          if (!isStale(error)) throw error;
        }
      }
    }
    const result = await send({ [WRITE]: { r, v: value } satisfies WriteMark });
    this.bases.set(name, { r, v: value });
    return result;
  }
}

/** 宿主侧（每个远端 renderer 一份）：还原写入值；handler 成功后 commit 才推进基线 */
export class RemoteWriteBases {
  private bases = new Map<string, LazyWriteBase>();

  seed(name: string, value: unknown): void {
    this.bases.set(name, { r: null, v: structuredClone(value) });
  }

  /** 推迟克隆与规范化 hash，直到远端真正发来增量写入才解析基线 */
  seedLazy(name: string, load: () => unknown): void {
    this.bases.set(name, { r: null, load });
  }

  resolve(name: string, arg: unknown): { value: unknown; commit: () => void } {
    const mark = markOf<WriteMark>(arg, WRITE);
    if (!mark) return { value: arg, commit: () => this.bases.delete(name) };
    if (typeof mark.r !== 'number') throw staleError();
    let value: unknown;
    if ('v' in mark) value = mark.v;
    else {
      const rawBase = this.bases.get(name);
      const base = rawBase ? materializeBase(rawBase) : undefined;
      if (!base || base.r !== mark.b || !Array.isArray(mark.ops)) throw staleError();
      value = applyJsonDelta(base.v, mark.ops);
    }
    // handler 可能就地改写或长期引用传入值，基线必须独立
    const stored = structuredClone(value);
    return { value, commit: () => this.bases.set(name, { r: mark.r, v: stored }) };
  }
}

interface CachedMark {
  h: string;
  same?: 1;
  b?: string;
  ops?: JsonOp[];
  v?: unknown;
}

export function withIfNone(encodedArgs: unknown[], hash: string): unknown[] {
  return [...encodedArgs, { [IF_NONE]: hash }];
}

export function withUpsertReset(encodedArgs: unknown[]): unknown[] {
  return [...encodedArgs, { [UPSERT_RESET]: 1 }];
}

/** 宿主侧：剥掉 shim 附加在参数末尾的标记 */
export function takeRemoteMarks(args: unknown[]): {
  args: unknown[];
  ifNone?: string;
  upsertReset?: true;
} {
  const last = args[args.length - 1];
  const ifNone = markOf<unknown>(last, IF_NONE);
  if (typeof ifNone === 'string') return { args: args.slice(0, -1), ifNone };
  if (markOf<unknown>(last, UPSERT_RESET) === 1)
    return { args: args.slice(0, -1), upsertReset: true };
  return { args };
}

/** 宿主侧全局：按内容 hash 记住最近发出的只读结果（已脱敏的编码值），用于回 same/增量 */
export class RemoteReadCache {
  private lru = new Map<string, { v: unknown; chars: number }>();
  private chars = 0;

  constructor(private hash: (json: string) => string) {}

  respond(value: unknown, ifNone: string): { [CACHED]: CachedMark } {
    const json = JSON.stringify(value ?? null);
    return this.respondPrehashed(value, this.hash(json), json.length, ifNone);
  }

  /** 宿主已按 revision 缓存好序列化 JSON 与 hash 时走此快路径，避免每次请求重复 JSON.stringify + sha1 */
  respondPrehashed(
    value: unknown,
    h: string,
    chars: number,
    ifNone: string
  ): { [CACHED]: CachedMark } {
    const base = ifNone ? this.lru.get(ifNone) : undefined;
    this.put(h, value, chars);
    if (ifNone === h) return { [CACHED]: { h, same: 1 } };
    if (base) {
      const ops = diffJson(base.v, value);
      if (worth(ops, chars)) return { [CACHED]: { h, b: ifNone, ops } };
    }
    return { [CACHED]: { h, v: value } };
  }

  private put(h: string, v: unknown, chars: number): void {
    const old = this.lru.get(h);
    if (old) this.chars -= old.chars;
    touch(this.lru, h, { v, chars }, Number.POSITIVE_INFINITY);
    this.chars += chars;
    while (this.lru.size > READ_CACHE_ENTRIES || this.chars > READ_CACHE_CHARS) {
      const [key, entry] = this.lru.entries().next().value as [string, { chars: number }];
      if (key === h) break;
      this.lru.delete(key);
      this.chars -= entry.chars;
    }
  }
}

export interface RemoteReadStore {
  get(key: string): { h: string; json: string } | undefined;
  set(key: string, value: { h: string; json: string }): unknown;
  delete(key: string): unknown;
  keys(): IterableIterator<string>;
}

export const MAX_REMOTE_PREFETCH_ITEMS = 16;

export const PREFETCH_READ_CHANNELS: ReadonlySet<string> = new Set([
  IPC_CHANNELS.SETTINGS_READ,
  IPC_CHANNELS.CONVERSATIONS_READ,
  IPC_CHANNELS.SOURCE_AUTHORITY_READ,
  IPC_CHANNELS.MODEL_DIRECTORY_GET,
  IPC_CHANNELS.PROVIDERS_MODEL_META,
  IPC_CHANNELS.EXTENSION_PLUGINS_LIST,
  IPC_CHANNELS.ASSETS_LIST_PROJECT_SKILLS,
  IPC_CHANNELS.SECRETARY_GET_STATE,
  IPC_CHANNELS.AGENT_PARENT_HISTORY_TAIL,
  IPC_CHANNELS.WORKTREE_LIST,
  IPC_CHANNELS.WORKTREE_STATUSES,
  IPC_CHANNELS.PROJECTS_GET_ICONS,
]);

const PREFETCH_PRIORITY: readonly string[] = [
  IPC_CHANNELS.SETTINGS_READ,
  IPC_CHANNELS.CONVERSATIONS_READ,
  IPC_CHANNELS.SOURCE_AUTHORITY_READ,
  IPC_CHANNELS.AGENT_PARENT_HISTORY_TAIL,
  IPC_CHANNELS.MODEL_DIRECTORY_GET,
  IPC_CHANNELS.PROVIDERS_MODEL_META,
  IPC_CHANNELS.EXTENSION_PLUGINS_LIST,
  IPC_CHANNELS.ASSETS_LIST_PROJECT_SKILLS,
  IPC_CHANNELS.SECRETARY_GET_STATE,
];

export interface CollectedPrefetchItem {
  ch: string;
  args: unknown[];
  h: string;
}

/** 从本地持久化读缓存提取可走 rpc-hello 1-RTT 预校验的只读请求 */
export function collectPrefetchItems(
  store: RemoteReadStore,
  limit = MAX_REMOTE_PREFETCH_ITEMS
): CollectedPrefetchItem[] {
  const candidates: { ch: string; args: unknown[]; h: string; priority: number }[] = [];
  for (const key of store.keys()) {
    const sep = key.indexOf('\0');
    if (sep <= 0) continue;
    const ch = key.slice(0, sep);
    if (!PREFETCH_READ_CHANNELS.has(ch)) continue;
    const entry = store.get(key);
    if (!entry || typeof entry.h !== 'string' || entry.h.length > 64) continue;
    let args: unknown;
    try {
      args = JSON.parse(key.slice(sep + 1));
    } catch {
      continue;
    }
    if (!Array.isArray(args)) continue;
    const idx = PREFETCH_PRIORITY.indexOf(ch);
    candidates.push({ ch, args, h: entry.h, priority: idx === -1 ? 999 : idx });
  }
  candidates.sort((a, b) => a.priority - b.priority);
  return candidates.slice(0, Math.max(0, limit)).map(({ ch, args, h }) => ({ ch, args, h }));
}

/** shim 侧：同时发出的相同读取共用一次请求；结果按 hash 缓存（store 可放在父页面，跨 iframe 重载保留） */
export class RemoteReadClient {
  private inflight = new Map<string, Promise<string>>();

  constructor(private store: RemoteReadStore) {}

  /** 返回已缓存版本的原始 JSON（供需要懒构建基线的调用方复解析，避免 startup structuredClone） */
  readJson(key: string, send: (ifNone: string) => Promise<unknown>): Promise<string> {
    let pending = this.inflight.get(key);
    if (!pending) {
      pending = this.fetch(key, send).finally(() => this.inflight.delete(key));
      this.inflight.set(key, pending);
    }
    return pending;
  }

  /** 返回编码值（每次调用独立副本） */
  async read(key: string, send: (ifNone: string) => Promise<unknown>): Promise<unknown> {
    return JSON.parse(await this.readJson(key, send));
  }

  private async fetch(key: string, send: (ifNone: string) => Promise<unknown>): Promise<string> {
    const entry = this.store.get(key);
    const reply = await send(entry?.h ?? '');
    const mark = markOf<CachedMark>(reply, CACHED);
    if (!mark) return JSON.stringify(reply ?? null);
    let json: string;
    if (mark.same && entry && entry.h === mark.h) json = entry.json;
    else if (mark.ops && entry && entry.h === mark.b) {
      json = JSON.stringify(applyJsonDelta(JSON.parse(entry.json), mark.ops));
    } else if ('v' in mark) json = JSON.stringify(mark.v ?? null);
    else {
      this.store.delete(key);
      return this.fetch(key, send);
    }
    this.save(key, { h: mark.h, json });
    return json;
  }

  private save(key: string, value: { h: string; json: string }): void {
    this.store.delete(key);
    this.store.set(key, value);
    let total = 0;
    for (const k of [...this.store.keys()].reverse()) {
      const chars = this.store.get(k)?.json.length ?? 0;
      total += chars;
      if (total > CLIENT_CACHE_CHARS && k !== key) this.store.delete(k);
    }
  }
}

interface UpsertMark {
  k: string;
  r: number;
  b?: number;
  ops?: JsonOp[];
}

/** 宿主侧（每个远端 renderer 一份）：message 为编码值 */
export class UpsertEncoder {
  private bases = new Map<string, { r: number; m: unknown }>();

  encode(key: string, message: unknown): { mark: UpsertMark; message?: unknown } {
    const prev = this.bases.get(key);
    const r = (prev?.r ?? 0) + 1;
    let out: { mark: UpsertMark; message?: unknown } | undefined;
    if (prev) {
      const ops = diffJson(prev.m, message);
      if (worth(ops, JSON.stringify(message).length)) out = { mark: { k: key, r, b: prev.r, ops } };
    }
    out ??= { mark: { k: key, r }, message };
    touch(this.bases, key, { r, m: message }, UPSERT_BASES);
    return out;
  }

  reset(): void {
    this.bases.clear();
  }
}

/** shim 侧：还原流式消息；缺基线返回 null（调用方应请求 reset 并重拉快照） */
export class UpsertDecoder {
  private bases = new Map<string, { r: number; m: unknown }>();

  decode(mark: unknown, message: unknown): unknown {
    const m = mark as Partial<UpsertMark> | undefined;
    if (!m || typeof m.k !== 'string' || typeof m.r !== 'number') return message ?? null;
    let value = message;
    if (m.ops !== undefined) {
      const base = this.bases.get(m.k);
      if (!base || base.r !== m.b || !Array.isArray(m.ops)) return null;
      try {
        value = applyJsonDelta(base.m, m.ops);
      } catch {
        return null;
      }
    }
    touch(this.bases, m.k, { r: m.r, m: value }, UPSERT_BASES);
    return value;
  }
}
