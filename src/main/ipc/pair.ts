import { ipcMain } from '@platform';
import { IPC_CHANNELS } from '@shared/types';
import { parsePairCatalogPayload } from '../services/pairCatalogStore';
import {
  cancelPairing,
  getPairStatus,
  renameDevice,
  revokeDevice,
  setDeviceScope,
  setPairProjectDeps,
  setPairQueueActionListener,
  setPairResumeListener,
  setPairSessionConfigListener,
  setPairSessionCreatedListener,
  setPairStatusListener,
  setRelayUrl,
  startPairing,
  updatePairCatalog,
} from '../services/pairHost';
import { isPairScope } from '../services/pairScope';
import {
  adoptPairSessionHeadless,
  applyPairQueueActionHeadless,
  applyPairSessionConfigHeadless,
  resumePairSessionHeadless,
} from '../services/pairSessionHost';
import { hasMainRenderer } from '../services/remoteRenderer';
import { broadcastToRenderers } from '../services/renderers';
import { getSourceAuthorityRegistry } from './agent';

export function registerPairHandlers(): void {
  // 另一台桌面添加项目：只登记权威注册表，renderer 收投影广播后更新项目列表并重推目录
  setPairProjectDeps({
    createProject: (request) => {
      const registry = getSourceAuthorityRegistry();
      return registry
        ? registry.createProject(request)
        : { accepted: false, error: 'Project registry is not ready.' };
    },
  });

  // 状态变化广播回设置页（配对成功、手机上下线、重连）
  setPairStatusListener(() => {
    const status = getPairStatus();
    broadcastToRenderers(IPC_CHANNELS.PAIR_STATUS_CHANGED, status);
  });

  // 手机订阅历史会话时，请渲染层按桌面同路径恢复（worker 里才有投影可发）
  setPairResumeListener((sessionId) => {
    if (hasMainRenderer()) broadcastToRenderers(IPC_CHANNELS.PAIR_RESUME_SESSION, sessionId);
    else void resumePairSessionHeadless(sessionId);
  });

  // 手机新建会话后请渲染层登记，否则桌面列表看不到它、其事件也会被丢弃
  setPairSessionCreatedListener((session) => {
    if (hasMainRenderer()) broadcastToRenderers(IPC_CHANNELS.PAIR_SESSION_CREATED, session);
    else adoptPairSessionHeadless(session);
  });

  // 手机改会话模型/推理档位：交给渲染层的 store 方法，与桌面选择器同一路径
  setPairSessionConfigListener((config) => {
    if (hasMainRenderer()) broadcastToRenderers(IPC_CHANNELS.PAIR_SESSION_CONFIG, config);
    else applyPairSessionConfigHeadless(config);
  });

  // 手机操作排队消息 / 会话目标：状态只在 renderer store，交给它处理
  setPairQueueActionListener((action) => {
    if (hasMainRenderer()) broadcastToRenderers(IPC_CHANNELS.PAIR_QUEUE_ACTION, action);
    else applyPairQueueActionHeadless(action);
  });

  ipcMain.handle(IPC_CHANNELS.PAIR_START, async () => startPairing());
  ipcMain.handle(IPC_CHANNELS.PAIR_CANCEL, () => {
    cancelPairing();
  });
  ipcMain.handle(IPC_CHANNELS.PAIR_REVOKE, async (_event, pairId: unknown) => {
    if (typeof pairId === 'string' && pairId) await revokeDevice(pairId);
  });
  ipcMain.handle(IPC_CHANNELS.PAIR_RENAME, (_event, pairId: unknown, deviceName: unknown) => {
    if (typeof pairId !== 'string' || !pairId || typeof deviceName !== 'string') {
      return { ok: false, error: 'invalid arguments' };
    }
    return renameDevice(pairId, deviceName);
  });
  ipcMain.handle(IPC_CHANNELS.PAIR_SET_SCOPE, (_event, pairId: unknown, scope: unknown) => {
    if (typeof pairId !== 'string' || !pairId || !isPairScope(scope)) {
      return { ok: false, error: 'invalid arguments' };
    }
    return setDeviceScope(pairId, scope);
  });
  ipcMain.handle(IPC_CHANNELS.PAIR_STATUS, () => getPairStatus());
  ipcMain.handle(IPC_CHANNELS.PAIR_SET_RELAY, (_event, url: unknown) => {
    if (typeof url === 'string') setRelayUrl(url);
    return getPairStatus();
  });

  // renderer 推目录：会话标题/项目/provider 只在 renderer 有，main 与 worker 都没有。
  // providers 必须已剥 apiKey/baseUrl；projectPaths 留在 main 侧用于 spawn 反查 cwd。
  ipcMain.on(IPC_CHANNELS.PAIR_CATALOG, (_event, payload: unknown) => {
    const parsed = parsePairCatalogPayload(payload);
    if (parsed) updatePairCatalog(parsed);
  });
}
