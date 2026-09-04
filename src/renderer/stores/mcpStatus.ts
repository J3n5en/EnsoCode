import type { McpConnectionState, McpStatusEvent } from '@shared/types/agent';
import { create } from 'zustand';

/**
 * MCP 连接状态 store：只反映 worker 上报的连接结果与 OAuth 授权态，不持久化。
 * key 为 McpServerEntry.id；旧配置缺 id 时兜底 serverName。
 */

export interface McpServerStatus {
  state: McpConnectionState;
  toolCount?: number;
  error?: string;
}

export type McpStatusMap = Record<string, McpServerStatus>;

export function statusKey(event: { serverId?: string; serverName: string }): string {
  return event.serverId ?? event.serverName;
}

export function applyStatusEvent(statuses: McpStatusMap, event: McpStatusEvent): McpStatusMap {
  const next = { ...statuses };
  // 曾按 serverName 落过的旧条目在拿到 id 后迁移，避免同一个 server 两行状态
  if (event.serverId) delete next[event.serverName];
  next[statusKey(event)] = {
    state: event.state,
    ...(event.toolCount !== undefined ? { toolCount: event.toolCount } : {}),
    ...(event.error ? { error: event.error } : {}),
  };
  return next;
}

/** 快照回填：Main 侧最近状态，晚打开的设置页据此显示（含授权入口） */
export function applyStatusSnapshot(events: readonly McpStatusEvent[]): McpStatusMap {
  return events.reduce<McpStatusMap>((acc, event) => applyStatusEvent(acc, event), {});
}

export function beginAuthorize(statuses: McpStatusMap, serverId: string): McpStatusMap {
  return { ...statuses, [serverId]: { state: 'connecting' } };
}

export function failAuthorize(
  statuses: McpStatusMap,
  serverId: string,
  error?: string
): McpStatusMap {
  return { ...statuses, [serverId]: { state: 'error', ...(error ? { error } : {}) } };
}

interface McpStatusState {
  statuses: McpStatusMap;
  authorized: Record<string, boolean>;
  /** 授权流程在途：按钮 loading */
  pending: Record<string, true>;
  bind: () => () => void;
  authorize: (serverId: string) => Promise<void>;
  revoke: (serverId: string) => Promise<void>;
}

const dropKey = <T>(record: Record<string, T>, key: string): Record<string, T> => {
  const next = { ...record };
  delete next[key];
  return next;
};

export const useMcpStatusStore = create<McpStatusState>()((set, get) => ({
  statuses: {},
  authorized: {},
  pending: {},

  bind: () => {
    void window.electronAPI.mcp
      .authState()
      .then((authorized) => set({ authorized }))
      .catch(() => undefined);
    void window.electronAPI.mcp
      .statusSnapshot()
      .then((events) => set({ statuses: { ...applyStatusSnapshot(events), ...get().statuses } }))
      .catch(() => undefined);
    return window.electronAPI.mcp.onStatus((push) => {
      if (push.type === 'mcp-status-cleared') {
        set({ statuses: {} });
        return;
      }
      set({ statuses: applyStatusEvent(get().statuses, push) });
    });
  },

  authorize: async (serverId) => {
    set({
      statuses: beginAuthorize(get().statuses, serverId),
      pending: { ...get().pending, [serverId]: true },
    });
    let result: { ok: boolean; error?: string };
    try {
      result = await window.electronAPI.mcp.authorize(serverId);
    } catch (error) {
      result = { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
    set({
      pending: dropKey(get().pending, serverId),
      ...(result.ok
        ? { authorized: { ...get().authorized, [serverId]: true } }
        : { statuses: failAuthorize(get().statuses, serverId, result.error) }),
    });
  },

  revoke: async (serverId) => {
    await window.electronAPI.mcp.revoke(serverId);
    set({
      authorized: dropKey(get().authorized, serverId),
      statuses: dropKey(get().statuses, serverId),
    });
  },
}));
