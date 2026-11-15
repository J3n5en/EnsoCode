/**
 * 远程桌面经中继的增量协议（浏览器 shim 与宿主同一构建，标记对壳页面透明）：
 * - 设置写入：shim 记住上次成功写入的值，之后只上传差异；宿主基线不符时报 stale，shim 改发整份。
 * - 只读结果：shim 带上已缓存版本的 hash，宿主未变回 same，变了且认得旧版本则回增量。
 * - 流式消息：同一条 message-upsert 只发与上一帧的差异；接收端缺基线时请求 reset 并重拉快照。
 */
import { applyJsonDelta, diffJson, type JsonOp } from './jsonDelta';

export const REMOTE_DELTA_STALE = 'remote-delta-stale';
const WRITE = '__ensoWrite';
const IF_NONE = '__ensoIfNone';
const CACHED = '__ensoCached';
const UPSERT_RESET = '__ensoUpsertReset';
export const UPSERT_MARK = '__ensoUpsert';

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

interface WriteMark {
  r: number;
  b?: number;
  ops?: JsonOp[];
  v?: unknown;
}

/** shim 侧：value 须是 JSON 安全的编码值且归调用方所有 */
export class RemoteWriteClient {
  private bases = new Map<string, { r: number; v: unknown }>();
  private chains = new Map<string, Promise<unknown>>();

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
    const base = this.bases.get(name);
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
  private bases = new Map<string, { r: number; v: unknown }>();

  resolve(name: string, arg: unknown): { value: unknown; commit: () => void } {
    const mark = markOf<WriteMark>(arg, WRITE);
    if (!mark) return { value: arg, commit: () => this.bases.delete(name) };
    if (typeof mark.r !== 'number') throw staleError();
    let value: unknown;
    if ('v' in mark) value = mark.v;
    else {
      const base = this.bases.get(name);
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
    const h = this.hash(json);
    const base = ifNone ? this.lru.get(ifNone) : undefined;
    this.put(h, value, json.length);
    if (ifNone === h) return { [CACHED]: { h, same: 1 } };
    if (base) {
      const ops = diffJson(base.v, value);
      if (worth(ops, json.length)) return { [CACHED]: { h, b: ifNone, ops } };
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

/** shim 侧：同时发出的相同读取共用一次请求；结果按 hash 缓存（store 可放在父页面，跨 iframe 重载保留） */
export class RemoteReadClient {
  private inflight = new Map<string, Promise<string>>();

  constructor(private store: RemoteReadStore) {}

  /** 返回编码值（每次调用独立副本） */
  async read(key: string, send: (ifNone: string) => Promise<unknown>): Promise<unknown> {
    let pending = this.inflight.get(key);
    if (!pending) {
      pending = this.fetch(key, send).finally(() => this.inflight.delete(key));
      this.inflight.set(key, pending);
    }
    return JSON.parse(await pending);
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
