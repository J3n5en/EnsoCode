/** 与现行 worker 硬编码一致；缺省条目必须落在这两个值上 */
export const DEFAULT_MCP_CONNECT_TIMEOUT_MS = 10_000;
export const DEFAULT_MCP_CALL_TIMEOUT_MS = 120_000;
export const MAX_MCP_CONNECT_TIMEOUT_SEC = 600;
export const MAX_MCP_CALL_TIMEOUT_SEC = 3_600;

/** 设置页 / 持久化：正整数秒；脏值视为未设置 */
export function parseMcpTimeoutSec(value: unknown, maxSec?: number): number | undefined {
  let sec: number;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed || !/^\d+$/.test(trimmed)) return undefined;
    sec = Number(trimmed);
  } else if (typeof value === 'number') {
    sec = value;
  } else {
    return undefined;
  }
  if (!Number.isInteger(sec) || sec <= 0) return undefined;
  return maxSec === undefined ? sec : Math.min(sec, maxSec);
}

export function resolveMcpTimeoutMs(sec: unknown, fallbackMs: number, maxSec?: number): number {
  const parsed = parseMcpTimeoutSec(sec, maxSec);
  return parsed === undefined ? fallbackMs : parsed * 1000;
}

/** spawn 只带非默认毫秒，避免每条连接都膨胀 */
export function mcpTimeoutsForSpawn(entry: {
  connectTimeoutSec?: unknown;
  callTimeoutSec?: unknown;
}): { connectTimeoutMs?: number; callTimeoutMs?: number } {
  const connectTimeoutMs = resolveMcpTimeoutMs(
    entry.connectTimeoutSec,
    DEFAULT_MCP_CONNECT_TIMEOUT_MS,
    MAX_MCP_CONNECT_TIMEOUT_SEC
  );
  const callTimeoutMs = resolveMcpTimeoutMs(
    entry.callTimeoutSec,
    DEFAULT_MCP_CALL_TIMEOUT_MS,
    MAX_MCP_CALL_TIMEOUT_SEC
  );
  return {
    ...(connectTimeoutMs !== DEFAULT_MCP_CONNECT_TIMEOUT_MS ? { connectTimeoutMs } : {}),
    ...(callTimeoutMs !== DEFAULT_MCP_CALL_TIMEOUT_MS ? { callTimeoutMs } : {}),
  };
}

export function mcpTimeoutMsOrDefault(value: unknown, fallbackMs: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallbackMs;
}
