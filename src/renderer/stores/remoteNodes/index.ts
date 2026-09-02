import type { PhoneToHost } from '@enso/pair';
import type { NodeMessage, NodesStatus, RemoteNodeStatus } from '@shared/types/nodes';
import { create } from 'zustand';
import {
  applyNodeMessage,
  type Cursors,
  emptyNodeView,
  type NodeEffect,
  type NodeView,
  onHostOnlineChanged,
  requestHistory as reduceRequestHistory,
  selectSession as reduceSelectSession,
} from './reducer';

/**
 * 远程节点 store：本机作为 guest 看到的别的桌面。
 * 传输与密钥在 main（pairGuest），这里只持有目录/会话投影与订阅状态。
 * 与本机 useSessionsStore 完全独立：切到远程节点时整个侧栏+聊天区换成 RemoteNodeView。
 */

export type ActiveNode = 'local' | string;

const ACTIVE_NODE_KEY = 'enso-active-node';
const cursorKey = (nodeId: string) => `enso-node-cursors:${nodeId}`;
const lastSessionKey = (nodeId: string) => `enso-node-last-session:${nodeId}`;

function loadCursors(nodeId: string): Cursors {
  try {
    const parsed = JSON.parse(localStorage.getItem(cursorKey(nodeId)) ?? '{}');
    return typeof parsed === 'object' && parsed !== null ? (parsed as Cursors) : {};
  } catch {
    return {};
  }
}

function saveCursor(nodeId: string, sessionId: string, index: number): void {
  const cursors = loadCursors(nodeId);
  if ((cursors[sessionId] ?? -1) >= index) return;
  cursors[sessionId] = index;
  localStorage.setItem(cursorKey(nodeId), JSON.stringify(cursors));
}

interface RemoteNodesState {
  nodes: RemoteNodeStatus[];
  secureStorage: boolean;
  activeNodeId: ActiveNode;
  byNode: Record<string, NodeView>;
  /** 本机刚 spawn、尚未收到目录的会话：首次订阅不进 syncing */
  freshIds: ReadonlySet<string>;

  /** 订阅 main 的状态/消息推送；App 挂载时调一次，返回清理函数 */
  bind: () => () => void;
  switchNode: (nodeId: ActiveNode) => void;
  selectSession: (nodeId: string, sessionId: string | null) => void;
  send: (nodeId: string, command: PhoneToHost) => void;
  requestHistory: (nodeId: string, sessionId: string) => void;
  /** 新建远程会话：本地生成 sessionId、发 spawn、立即选中 */
  spawn: (
    nodeId: string,
    request: Omit<Extract<PhoneToHost, { type: 'spawn' }>, 'type' | 'sessionId'>
  ) => string;
  /** 重新配对/解绑等外部动作后刷新列表 */
  refresh: () => Promise<void>;
}

export const useRemoteNodesStore = create<RemoteNodesState>()((set, get) => {
  const viewOf = (nodeId: string): NodeView => get().byNode[nodeId] ?? emptyNodeView();

  const runEffects = (nodeId: string, effects: NodeEffect[]): void => {
    for (const effect of effects) {
      switch (effect.kind) {
        case 'send':
          void window.electronAPI.nodes.send(nodeId, effect.command);
          break;
        case 'cursor':
          saveCursor(nodeId, effect.sessionId, effect.index);
          break;
        case 'ghost':
          // reducer 已清 activeSessionId；这里只需把「最近会话」记忆抹掉
          localStorage.removeItem(lastSessionKey(nodeId));
          break;
      }
    }
  };

  const commit = (nodeId: string, view: NodeView, effects: NodeEffect[]): void => {
    set({ byNode: { ...get().byNode, [nodeId]: view } });
    runEffects(nodeId, effects);
  };

  const applyStatus = (status: NodesStatus): void => {
    const prev = get().nodes;
    set({ nodes: status.nodes, secureStorage: status.secureStorage });
    // 节点被删（解绑/被对方解绑）：正在看它就切回本机
    const known = new Set(status.nodes.map((n) => n.nodeId));
    const active = get().activeNodeId;
    if (active !== 'local' && !known.has(active)) get().switchNode('local');
    // 对方上线：重订阅 + 拉目录
    for (const node of status.nodes) {
      const before = prev.find((n) => n.nodeId === node.nodeId)?.hostOnline ?? false;
      if (!before && node.hostOnline) {
        const r = onHostOnlineChanged(viewOf(node.nodeId), true, loadCursors(node.nodeId));
        commit(node.nodeId, r.view, r.effects);
      }
    }
  };

  return {
    nodes: [],
    secureStorage: true,
    activeNodeId: (localStorage.getItem(ACTIVE_NODE_KEY) as ActiveNode | null) ?? 'local',
    byNode: {},
    freshIds: new Set(),

    bind: () => {
      void get().refresh();
      const offStatus = window.electronAPI.nodes.onStatusChanged(applyStatus);
      const offMessage = window.electronAPI.nodes.onMessage((message: NodeMessage) => {
        const r = applyNodeMessage(viewOf(message.nodeId), message.payload);
        if (r.view === get().byNode[message.nodeId]) return;
        commit(message.nodeId, r.view, r.effects);
      });
      return () => {
        offStatus();
        offMessage();
      };
    },

    refresh: async () => {
      const status = await window.electronAPI.nodes.list();
      applyStatus(status);
    },

    switchNode: (nodeId) => {
      const current = get().activeNodeId;
      if (current === nodeId) return;
      localStorage.setItem(ACTIVE_NODE_KEY, nodeId);
      set({ activeNodeId: nodeId });
      if (nodeId === 'local') return;
      // 切到远程节点：恢复上次看的会话（或列表态）；目录由 host 在进房时下发/这里再要一次
      const view = viewOf(nodeId);
      const last = localStorage.getItem(lastSessionKey(nodeId));
      const target = last && view.catalog.some((e) => e.id === last) ? last : view.activeSessionId;
      const r = reduceSelectSession(view, target, loadCursors(nodeId));
      commit(nodeId, r.view, [...r.effects, { kind: 'send', command: { type: 'snapshot' } }]);
    },

    selectSession: (nodeId, sessionId) => {
      const fresh = sessionId !== null && get().freshIds.has(sessionId);
      const r = reduceSelectSession(viewOf(nodeId), sessionId, loadCursors(nodeId), { fresh });
      if (fresh) {
        const next = new Set(get().freshIds);
        next.delete(sessionId);
        set({ freshIds: next });
      }
      if (sessionId) localStorage.setItem(lastSessionKey(nodeId), sessionId);
      else localStorage.removeItem(lastSessionKey(nodeId));
      commit(nodeId, r.view, r.effects);
    },

    send: (nodeId, command) => {
      void window.electronAPI.nodes.send(nodeId, command);
    },

    requestHistory: (nodeId, sessionId) => {
      const r = reduceRequestHistory(viewOf(nodeId), sessionId);
      if (r.effects.length === 0) return;
      commit(nodeId, r.view, r.effects);
    },

    spawn: (nodeId, request) => {
      const sessionId = crypto.randomUUID();
      void window.electronAPI.nodes.send(nodeId, { type: 'spawn', sessionId, ...request });
      set({ freshIds: new Set([...get().freshIds, sessionId]) });
      get().selectSession(nodeId, sessionId);
      return sessionId;
    },
  };
});
