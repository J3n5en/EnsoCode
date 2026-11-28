import type { PhoneToHost, RemotePrefetchItem, RemoteToHost } from '@enso/pair';
import { MAX_REMOTE_PREFETCH_ITEMS } from '@shared/remoteDelta';

type Check = { ok: true; command: PhoneToHost } | { ok: false; error: string };

const isId = (v: unknown): v is string =>
  typeof v === 'string' && v.length > 0 && v.length <= 64 && /^[\w-]+$/.test(v);
const isChannel = (v: unknown): v is string =>
  typeof v === 'string' && v.length > 0 && v.length <= 128 && /^[\w:./-]+$/.test(v);
const isSeq = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0;

function parsePrefetch(raw: unknown): RemotePrefetchItem[] | null {
  if (!Array.isArray(raw) || raw.length > MAX_REMOTE_PREFETCH_ITEMS) return null;
  const out: RemotePrefetchItem[] = [];
  for (const item of raw) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) return null;
    const record = item as Record<string, unknown>;
    if (
      !isChannel(record.ch) ||
      !Array.isArray(record.args) ||
      typeof record.h !== 'string' ||
      record.h.length > 64
    ) {
      return null;
    }
    out.push({ ch: record.ch, args: record.args, h: record.h });
  }
  return out;
}

export function parseRemoteCommand(v: Record<string, unknown>): Check {
  const ok = (command: RemoteToHost): Check => ({ ok: true, command });
  switch (v.type) {
    case 'rpc-hello': {
      if (!isId(v.cid)) return { ok: false, error: 'invalid cid' };
      if (v.kind !== 'main') return { ok: false, error: 'invalid kind' };
      if (v.seq !== undefined && !isSeq(v.seq)) return { ok: false, error: 'invalid seq' };
      if (v.page !== undefined && !isId(v.page)) return { ok: false, error: 'invalid page' };
      let prefetch: RemotePrefetchItem[] | undefined;
      if (v.prefetch !== undefined) {
        const parsed = parsePrefetch(v.prefetch);
        if (!parsed) return { ok: false, error: 'invalid prefetch' };
        prefetch = parsed;
      }
      return ok({
        type: 'rpc-hello',
        cid: v.cid,
        kind: v.kind,
        ...(v.seq !== undefined ? { seq: v.seq } : {}),
        ...(v.page !== undefined ? { page: v.page } : {}),
        ...(prefetch !== undefined ? { prefetch } : {}),
      });
    }
    case 'rpc-bye':
      if (!isId(v.cid)) return { ok: false, error: 'invalid cid' };
      return ok({ type: 'rpc-bye', cid: v.cid });
    case 'rpc-invoke':
      if (!isId(v.cid) || !isSeq(v.id) || !isChannel(v.ch) || !Array.isArray(v.args)) {
        return { ok: false, error: 'invalid rpc-invoke' };
      }
      return ok({ type: 'rpc-invoke', cid: v.cid, id: v.id, ch: v.ch, args: v.args });
    case 'rpc-send':
      if (
        !isId(v.cid) ||
        !isChannel(v.ch) ||
        !Array.isArray(v.args) ||
        (v.id !== undefined && !isSeq(v.id))
      ) {
        return { ok: false, error: 'invalid rpc-send' };
      }
      return ok({
        type: 'rpc-send',
        cid: v.cid,
        ...(v.id !== undefined ? { id: v.id } : {}),
        ch: v.ch,
        args: v.args,
      });
    case 'asset-get':
      if (!isSeq(v.id) || typeof v.path !== 'string' || v.path.length > 8192) {
        return { ok: false, error: 'invalid asset-get' };
      }
      return ok({ type: 'asset-get', id: v.id, path: v.path });
    case 'remote-ack':
      if (!isSeq(v.bytes)) return { ok: false, error: 'invalid remote-ack' };
      return ok({
        type: 'remote-ack',
        bytes: v.bytes,
        ...(v.gzip === true ? { gzip: true } : {}),
        ...(v.v2 === true ? { v2: true } : {}),
      });
    default:
      return { ok: false, error: 'unknown remote command' };
  }
}

export const isRemoteCommandType = (type: unknown): boolean =>
  type === 'rpc-hello' ||
  type === 'rpc-bye' ||
  type === 'rpc-invoke' ||
  type === 'rpc-send' ||
  type === 'asset-get' ||
  type === 'remote-ack';
