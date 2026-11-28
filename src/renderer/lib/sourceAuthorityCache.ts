import type { SourceAuthorityProjection } from '@shared/types/agent';

const AUTHORITY_CACHE_TTL_MS = 5_000;

let cached: { at: number; value: SourceAuthorityProjection } | null = null;
let inflight: Promise<SourceAuthorityProjection> | null = null;

/** 启动时 settings / sessions 等多个 store 会同时读权威目录；合并在途请求并短时复用，减少启动 RPC */
export function readSharedSourceAuthority(): Promise<SourceAuthorityProjection> {
  if (cached && Date.now() - cached.at < AUTHORITY_CACHE_TTL_MS) {
    return Promise.resolve(cached.value);
  }
  inflight ??= window.electronAPI.sourceAuthority
    .read()
    .then((value) => {
      cached = { at: Date.now(), value };
      return value;
    })
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

/** 收到 Main 推送的新权威投影时顺便刷新缓存，避免随后读取又打一遍 IPC */
export function noteSourceAuthorityProjection(projection: SourceAuthorityProjection): void {
  cached = { at: Date.now(), value: projection };
}

export function resetSourceAuthorityCache(): void {
  cached = null;
  inflight = null;
}
