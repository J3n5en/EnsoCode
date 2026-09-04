import type { McpStatusEvent } from '@shared/types/agent';

/**
 * MCP 连接状态最近值：worker 只在建连那刻上报，设置页可能晚于上报才打开，
 * 所以 Main 兜住最近一次状态供快照拉取。key = serverId ?? serverName。
 */
const statuses = new Map<string, McpStatusEvent>();

export function recordMcpStatus(event: McpStatusEvent): void {
  // 曾按 serverName 落过的旧条目在拿到 id 后迁移，避免同一 server 两行状态
  if (event.serverId) statuses.delete(event.serverName);
  statuses.set(event.serverId ?? event.serverName, event);
}

export function mcpStatusSnapshot(): McpStatusEvent[] {
  return [...statuses.values()];
}

export function resetMcpStatuses(): void {
  statuses.clear();
}

/** worker 退出时调用；idle 记的是「已授权待连接」，非 worker 派生，保留 */
export function clearMcpStatuses(): void {
  for (const [key, event] of statuses) {
    if (event.state !== 'idle') statuses.delete(key);
  }
}
