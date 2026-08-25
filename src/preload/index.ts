import type {
  CollectedAsset,
  CollectedProvider,
  ListModelsResult,
  LocalAssetScanResult,
  LocalProviderScanResult,
  ProviderApiConfig,
  TestProviderResult,
} from '@shared/types';
import { IPC_CHANNELS } from '@shared/types';
import type {
  AgentActionResult,
  AgentSpawnRequest,
  ApprovalDecision,
  ApprovalMode,
  AttachedImage,
  RendererAgentEvent,
  ThinkingLevel,
} from '@shared/types/agent';
import type { ExternalSessionSource, SimpleMessage } from '@shared/types/sessionImport';
import { contextBridge, ipcRenderer, webUtils } from 'electron';

const electronAPI = {
  env: {
    platform: process.platform,
  },

  settings: {
    read: (): Promise<Record<string, unknown> | null> =>
      ipcRenderer.invoke(IPC_CHANNELS.SETTINGS_READ),
    write: (data: Record<string, unknown>): Promise<boolean> =>
      ipcRenderer.invoke(IPC_CHANNELS.SETTINGS_WRITE, data),
    /** 其他窗口修改设置后触发，用于多窗口同步 */
    onChanged: (callback: () => void): (() => void) => {
      const listener = () => callback();
      ipcRenderer.on(IPC_CHANNELS.SETTINGS_CHANGED, listener);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.SETTINGS_CHANGED, listener);
    },
  },

  providers: {
    scanLocal: (): Promise<LocalProviderScanResult> =>
      ipcRenderer.invoke(IPC_CHANNELS.PROVIDERS_SCAN_LOCAL),
    collectImport: (scanId: string, candidateIds: string[]): Promise<CollectedProvider[]> =>
      ipcRenderer.invoke(IPC_CHANNELS.PROVIDERS_COLLECT_IMPORT, scanId, candidateIds),
    listModels: (config: ProviderApiConfig): Promise<ListModelsResult> =>
      ipcRenderer.invoke(IPC_CHANNELS.PROVIDERS_LIST_MODELS, config),
    test: (config: ProviderApiConfig, modelId?: string): Promise<TestProviderResult> =>
      ipcRenderer.invoke(IPC_CHANNELS.PROVIDERS_TEST, config, modelId),
  },

  assets: {
    scanLocal: (): Promise<LocalAssetScanResult> =>
      ipcRenderer.invoke(IPC_CHANNELS.ASSETS_SCAN_LOCAL),
    collectImport: (scanId: string, candidateIds: string[]): Promise<CollectedAsset[]> =>
      ipcRenderer.invoke(IPC_CHANNELS.ASSETS_COLLECT_IMPORT, scanId, candidateIds),
  },

  instructions: {
    /** local 为 false 时读源文件，为 true 时读本地副本 */
    read: (
      id: string,
      local: boolean,
      sourcePath?: string
    ): Promise<{ ok: boolean; content: string; error?: string }> =>
      ipcRenderer.invoke(IPC_CHANNELS.INSTRUCTIONS_READ, id, local, sourcePath),
    /** 写入本地副本，首次写入即完成 copy-on-write */
    write: (id: string, content: string): Promise<{ ok: boolean; bytes: number }> =>
      ipcRenderer.invoke(IPC_CHANNELS.INSTRUCTIONS_WRITE, id, content),
    /** 直接写回源应用的原文件（会改动对方配置） */
    writeSource: (
      id: string,
      sourcePath: string,
      content: string
    ): Promise<{ ok: boolean; bytes: number; error?: string }> =>
      ipcRenderer.invoke(IPC_CHANNELS.INSTRUCTIONS_WRITE_SOURCE, id, sourcePath, content),
    delete: (id: string): Promise<void> => ipcRenderer.invoke(IPC_CHANNELS.INSTRUCTIONS_DELETE, id),
  },

  dialog: {
    /** 打开系统目录选择框，取消时返回 null */
    selectDirectory: (): Promise<string | null> =>
      ipcRenderer.invoke(IPC_CHANNELS.DIALOG_SELECT_DIRECTORY),
  },

  files: {
    /** 在 root 下按文件名/路径模糊搜索（@ 提及用） */
    search: (root: string, query: string): Promise<{ relativePath: string; name: string }[]> =>
      ipcRenderer.invoke(IPC_CHANNELS.FILES_SEARCH, root, query),
    /** 取粘贴/拖入的 File 对象的磁盘路径（渲染层拿不到，需经 webUtils） */
    pathForFile: (file: File): string => webUtils.getPathForFile(file),
    /** 读取文件内容（edit diff 还原上下文/行号用）；失败返回 null */
    read: (filePath: string): Promise<string | null> =>
      ipcRenderer.invoke(IPC_CHANNELS.FILES_READ, filePath),
  },

  sessionImport: {
    /** 列出各本地 AI 应用在项目目录下的会话 */
    scan: (projectPath: string): Promise<ExternalSessionSource[]> =>
      ipcRenderer.invoke(IPC_CHANNELS.SESSIONS_SCAN_EXTERNAL, projectPath),
    /** 读取外部会话的拉平消息（预览用） */
    read: (sourceId: string, sessionPath: string): Promise<SimpleMessage[]> =>
      ipcRenderer.invoke(IPC_CHANNELS.SESSIONS_READ_EXTERNAL, sourceId, sessionPath),
    /** 转成 pi jsonl，返回可 resume 的文件与标题 */
    import: (
      sourceId: string,
      sessionPath: string,
      projectPath: string
    ): Promise<{ sessionFile: string; title: string; messageCount: number } | null> =>
      ipcRenderer.invoke(IPC_CHANNELS.SESSIONS_IMPORT_EXTERNAL, sourceId, sessionPath, projectPath),
  },

  agent: {
    spawn: (request: AgentSpawnRequest): Promise<AgentActionResult> =>
      ipcRenderer.invoke(IPC_CHANNELS.AGENT_SPAWN, request),
    prompt: (
      sessionId: string,
      text: string,
      images?: AttachedImage[]
    ): Promise<AgentActionResult> =>
      ipcRenderer.invoke(IPC_CHANNELS.AGENT_PROMPT, sessionId, text, images),
    steer: (
      sessionId: string,
      text: string,
      images?: AttachedImage[]
    ): Promise<AgentActionResult> =>
      ipcRenderer.invoke(IPC_CHANNELS.AGENT_STEER, sessionId, text, images),
    abort: (sessionId: string): Promise<AgentActionResult> =>
      ipcRenderer.invoke(IPC_CHANNELS.AGENT_ABORT, sessionId),
    /** 请求 worker 全量投影快照（结果经 onEvent 回来），用于刷新后补投影 */
    requestSnapshot: (): Promise<AgentActionResult> =>
      ipcRenderer.invoke(IPC_CHANNELS.AGENT_SNAPSHOT),
    setThinking: (sessionId: string, level: ThinkingLevel): Promise<AgentActionResult> =>
      ipcRenderer.invoke(IPC_CHANNELS.AGENT_SET_THINKING, sessionId, level),
    setReasoning: (
      sessionId: string,
      enabled: boolean,
      level?: ThinkingLevel
    ): Promise<AgentActionResult> =>
      ipcRenderer.invoke(IPC_CHANNELS.AGENT_SET_REASONING, sessionId, enabled, level),
    respondApproval: (
      sessionId: string,
      requestId: string,
      decision: ApprovalDecision
    ): Promise<AgentActionResult> =>
      ipcRenderer.invoke(IPC_CHANNELS.AGENT_APPROVAL_RESPOND, sessionId, requestId, decision),
    setApprovalMode: (sessionId: string, mode: ApprovalMode): Promise<AgentActionResult> =>
      ipcRenderer.invoke(IPC_CHANNELS.AGENT_SET_APPROVAL_MODE, sessionId, mode),
    stopTask: (sessionId: string, taskId: string): Promise<AgentActionResult> =>
      ipcRenderer.invoke(IPC_CHANNELS.AGENT_TASK_STOP, sessionId, taskId),
    /** 系统通知点击后由 main 下发：切到对应会话 */
    onFocusSession: (callback: (sessionId: string) => void): (() => void) => {
      const listener = (_: unknown, sessionId: string) => callback(sessionId);
      ipcRenderer.on(IPC_CHANNELS.NOTIFICATION_FOCUS_SESSION, listener);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.NOTIFICATION_FOCUS_SESSION, listener);
    },
    onEvent: (callback: (event: RendererAgentEvent) => void): (() => void) => {
      const listener = (_: unknown, event: RendererAgentEvent) => callback(event);
      ipcRenderer.on(IPC_CHANNELS.AGENT_EVENT, listener);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.AGENT_EVENT, listener);
    },
  },

  window: {
    minimize: (): Promise<void> => ipcRenderer.invoke(IPC_CHANNELS.WINDOW_MINIMIZE),
    maximize: (): Promise<void> => ipcRenderer.invoke(IPC_CHANNELS.WINDOW_MAXIMIZE),
    close: (): Promise<void> => ipcRenderer.invoke(IPC_CHANNELS.WINDOW_CLOSE),
    isMaximized: (): Promise<boolean> => ipcRenderer.invoke(IPC_CHANNELS.WINDOW_IS_MAXIMIZED),
    isFullScreen: (): Promise<boolean> => ipcRenderer.invoke(IPC_CHANNELS.WINDOW_IS_FULLSCREEN),
    setTrafficLightsVisible: (visible: boolean): Promise<void> =>
      ipcRenderer.invoke(IPC_CHANNELS.WINDOW_SET_TRAFFIC_LIGHTS_VISIBLE, visible),
    openSettings: (): Promise<void> => ipcRenderer.invoke(IPC_CHANNELS.WINDOW_OPEN_SETTINGS),
    onMaximizedChange: (callback: (maximized: boolean) => void): (() => void) => {
      const listener = (_: unknown, maximized: boolean) => callback(maximized);
      ipcRenderer.on(IPC_CHANNELS.WINDOW_MAXIMIZED_CHANGED, listener);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.WINDOW_MAXIMIZED_CHANGED, listener);
    },
    onFullScreenChange: (callback: (fullscreen: boolean) => void): (() => void) => {
      const listener = (_: unknown, fullscreen: boolean) => callback(fullscreen);
      ipcRenderer.on(IPC_CHANNELS.WINDOW_FULLSCREEN_CHANGED, listener);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.WINDOW_FULLSCREEN_CHANGED, listener);
    },
  },
};

export type ElectronAPI = typeof electronAPI;

contextBridge.exposeInMainWorld('electronAPI', electronAPI);
