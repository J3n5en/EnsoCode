import { IPC_CHANNELS } from '@shared/types';
import type { AgentActionResult, AgentSpawnRequest } from '@shared/types/agent';
import { BrowserWindow, ipcMain } from 'electron';
import {
  abortSession,
  promptSession,
  requestSnapshot,
  setAgentEventListener,
  spawnSession,
  steerSession,
} from '../services/agentHost';

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0;

export function registerAgentHandlers(): void {
  setAgentEventListener((event) => {
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send(IPC_CHANNELS.AGENT_EVENT, event);
    }
  });

  ipcMain.handle(IPC_CHANNELS.AGENT_SPAWN, (_event, request: unknown): AgentActionResult => {
    const req = request as AgentSpawnRequest;
    if (
      !req ||
      !isNonEmptyString(req.sessionId) ||
      !isNonEmptyString(req.providerId) ||
      !isNonEmptyString(req.modelId) ||
      typeof req.cwd !== 'string'
    ) {
      return { ok: false, error: 'invalid spawn request' };
    }
    return spawnSession(req);
  });

  ipcMain.handle(
    IPC_CHANNELS.AGENT_PROMPT,
    (_event, sessionId: unknown, text: unknown): AgentActionResult => {
      if (!isNonEmptyString(sessionId) || !isNonEmptyString(text)) {
        return { ok: false, error: 'invalid prompt' };
      }
      return promptSession(sessionId, text);
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.AGENT_STEER,
    (_event, sessionId: unknown, text: unknown): AgentActionResult => {
      if (!isNonEmptyString(sessionId) || !isNonEmptyString(text)) {
        return { ok: false, error: 'invalid steer' };
      }
      return steerSession(sessionId, text);
    }
  );

  ipcMain.handle(IPC_CHANNELS.AGENT_ABORT, (_event, sessionId: unknown): AgentActionResult => {
    if (!isNonEmptyString(sessionId)) return { ok: false, error: 'invalid abort' };
    return abortSession(sessionId);
  });

  ipcMain.handle(IPC_CHANNELS.AGENT_SNAPSHOT, (): AgentActionResult => requestSnapshot());
}
