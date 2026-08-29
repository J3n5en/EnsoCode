import { parseCapabilityAskResponse } from '@shared/capabilities/types';
import { IPC_CHANNELS } from '@shared/types';
import type { AgentWorkerEvent } from '@shared/types/agent';
import { app, BrowserWindow, ipcMain, webContents } from 'electron';
import { appendSessionCustomEntry, sendCapabilityResultToSession } from '../services/agentHost';
import { AgentSessionIndex } from '../services/agentSessionIndex';
import { CapabilityGateway, type CapabilityGatewayTransport } from '../services/capabilityGateway';
import { deleteInstruction, readInstruction, writeInstruction } from '../services/instructionStore';
import { queryModelMeta } from '../services/modelMeta';
import {
  beginOauthLogin,
  cancelOauthLogin,
  getOauthAccountUsage,
  listOauthProviders,
  oauthLogout,
  readStoredOauthCredentialKeys,
  readStoredOauthSecretValues,
  reopenOauthLogin,
} from '../services/oauthProviders';
import { listModels, testProvider } from '../services/providerApi';
import { getRecentProjects } from '../services/recentProjects';
import { patchSettingsState, readSettings, removeProjectAndConversations } from './settings';

function senderById(webContentsId?: number): Electron.WebContents | undefined {
  if (webContentsId === undefined || webContentsId < 0) return undefined;
  const sender = webContents.fromId(webContentsId);
  return sender && !sender.isDestroyed() ? sender : undefined;
}

function updaterAvailable(): boolean {
  return !(process.platform === 'linux' && !process.env.APPIMAGE);
}

export const agentSessionIndex = new AgentSessionIndex({ readSettings });

const transport: CapabilityGatewayTransport = {
  hasWindow: (webContentsId) => Boolean(senderById(webContentsId)),
  sendAsk: (webContentsId, request) => {
    senderById(webContentsId)?.send(IPC_CHANNELS.CAPABILITIES_ASK, request);
  },
  appendChildReceipt: async (identity, receipt) =>
    appendSessionCustomEntry(identity, { kind: 'capability-receipt', receipt }).ok,
  observeReceipt: (event) => {
    void import('./agent').then(({ getAgentDispatchService }) => {
      getAgentDispatchService()?.observeReceipt(event);
    });
  },
};

export const capabilityGateway = new CapabilityGateway(
  {
    readSettings,
    patchSettings: (field, value, ownerWebContentsId) =>
      patchSettingsState(field, value, senderById(ownerWebContentsId), 'all-renderers'),
    removeProject: (projectId, ownerWebContentsId) =>
      removeProjectAndConversations(projectId, senderById(ownerWebContentsId), 'all-renderers'),
    listModels,
    testProvider,
    queryModelMeta,
    listOauthProviders,
    readOauthCredentialKeys: readStoredOauthCredentialKeys,
    readSecretValues: readStoredOauthSecretValues,
    beginOauthLogin: (providerId, identity, signal) => {
      const sender = senderById(identity.ownerWebContentsId);
      if (!sender) {
        return {
          start: {
            status: 'failed' as const,
            code: 'invalid-owner',
            message: 'OAuth owner is unavailable',
          },
        };
      }
      return beginOauthLogin(providerId, sender, identity, signal);
    },
    oauthLogout: async (accountKey, ownerWebContentsId) => {
      await oauthLogout(accountKey, senderById(ownerWebContentsId));
    },
    getOauthAccountUsage,
    cancelOauthLogin,
    reopenOauthLogin,
    readInstruction,
    writeInstruction,
    deleteInstruction,
    getRecentProjects,
    updaterAvailable,
    checkForUpdates: async () => {
      const { autoUpdaterService } = await import('../services/updater/AutoUpdater');
      await autoUpdaterService.checkForUpdates();
    },
    downloadUpdate: async () => {
      const { autoUpdaterService } = await import('../services/updater/AutoUpdater');
      await autoUpdaterService.downloadUpdate();
    },
    sessionIndex: agentSessionIndex,
    hireCoworker: async (parentConversationId, name, agentType, guard) => {
      // agent IPC owns the initialized dispatcher; dynamic import avoids a module-init cycle.
      const { getAgentDispatchService } = await import('./agent');
      const service = getAgentDispatchService();
      if (!service) {
        return { ok: false, code: 'unavailable', error: 'Agent dispatcher is unavailable.' };
      }
      const result = await service.hireCoworker(parentConversationId, name, agentType, guard);
      return result.ok
        ? { ok: true, data: result.data }
        : {
            ok: false,
            code: 'unavailable',
            error: result.error,
            suggestedAction: result.suggestedAction,
          };
    },
    dismissCoworker: async (parentConversationId, coworkerId, guard) => {
      // 同上：只有 registerAgentHandlers 完成后才有生产实例。
      const { getAgentDispatchService } = await import('./agent');
      const service = getAgentDispatchService();
      if (!service) {
        return { ok: false, code: 'unavailable', error: 'Agent dispatcher is unavailable.' };
      }
      const result = await service.dismissCoworker(parentConversationId, coworkerId, guard);
      return result.ok
        ? { ok: true, data: result.data }
        : {
            ok: false,
            code: 'unavailable',
            error: result.error,
            suggestedAction: result.suggestedAction,
          };
    },
  },
  transport
);

export function handleCapabilityInvoke(
  event: Extract<AgentWorkerEvent, { type: 'capability-invoke' }>
): void {
  void capabilityGateway
    .invoke({
      child: event.child,
      turnId: event.turnId,
      requestId: event.requestId,
      capabilityId: event.capabilityId,
      params: event.params,
    })
    .then((envelope) => {
      sendCapabilityResultToSession(event.child, event.turnId, event.requestId, envelope);
    });
}

export function registerCapabilityHandlers(): void {
  ipcMain.handle(IPC_CHANNELS.CAPABILITIES_RESPOND, (event, raw: unknown) => {
    const response = parseCapabilityAskResponse(raw);
    if (!response) {
      return {
        ok: false,
        accepted: false,
        state: 'settled',
        error: 'Invalid capability response',
      };
    }
    return capabilityGateway.respond(event.sender.id, response);
  });

  app.on('browser-window-created', (_event, window) => {
    window.once('closed', () => capabilityGateway.releaseWindow(window.webContents.id));
  });
  app.on('before-quit', () => capabilityGateway.denyAll('Application is exiting.'));
}

/** 测试/关闭路径使用；普通窗口生命周期由 browser-window-created 接线。 */
export function liveCapabilityWindowIds(): number[] {
  return BrowserWindow.getAllWindows()
    .filter((window) => !window.isDestroyed() && !window.webContents.isDestroyed())
    .map((window) => window.webContents.id);
}
