import type { NodesStatus, RemoteNodeStatus } from '@shared/types/nodes';
import { create } from 'zustand';

/**
 * 远程节点 store：本机作为 guest 连上的别的桌面（列表与在线状态）及主窗口当前可见层。
 * 连接、密钥与可见层都在 main：切到节点时 main 在主窗口叠上对方的完整界面。
 */

export type ActiveNode = 'local' | string;

interface RemoteNodesState {
  nodes: RemoteNodeStatus[];
  secureStorage: boolean;
  /** 主窗口当前可见层（main 为权威源，经 nodes:active-changed 同步） */
  activeNodeId: ActiveNode;
  pairDialogOpen: boolean;
  /** 订阅 main 的状态与可见层推送，返回清理函数 */
  bind: () => () => void;
  /** 请 main 切换主窗口可见层；activeNodeId 随 main 广播更新 */
  switchNode: (nodeId: ActiveNode) => void;
  /** 节点层里不在此配对：请所在电脑切回本机，由本机界面打开对话框，配对链接只在本机界面输入 */
  requestPairDialog: () => void;
  setPairDialogOpen: (open: boolean) => void;
  /** 重新配对/解绑等外部动作后刷新列表 */
  refresh: () => Promise<void>;
}

export const useRemoteNodesStore = create<RemoteNodesState>()((set) => {
  const applyStatus = (status: NodesStatus): void =>
    set({ nodes: status.nodes, secureStorage: status.secureStorage });
  const applyActive = (activeNodeId: ActiveNode): void => set({ activeNodeId });

  return {
    nodes: [],
    secureStorage: true,
    activeNodeId: 'local',
    pairDialogOpen: false,

    bind: () => {
      const offStatus = window.electronAPI.nodes.onStatusChanged(applyStatus);
      const offActive = window.electronAPI.nodes.onActiveChanged(applyActive);
      const offPair = window.electronAPI.nodes.onPairRequested(() => set({ pairDialogOpen: true }));
      void window.electronAPI.nodes.list().then(applyStatus);
      void window.electronAPI.nodes.active().then(applyActive);
      return () => {
        offStatus();
        offActive();
        offPair();
      };
    },

    refresh: async () => {
      applyStatus(await window.electronAPI.nodes.list());
    },

    switchNode: (nodeId) => {
      void window.electronAPI.nodes.switch(nodeId);
    },

    requestPairDialog: () => {
      if (window.electronAPI.remote?.nativePlatform) void window.electronAPI.nodes.requestPair();
      else set({ pairDialogOpen: true });
    },

    setPairDialogOpen: (pairDialogOpen) => set({ pairDialogOpen }),
  };
});
