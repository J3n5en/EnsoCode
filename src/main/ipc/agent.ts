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
import { searchFiles } from '../services/fileSearch';

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0;

const isValidImages = (value: unknown): value is { data: string; mimeType: string }[] | undefined =>
  value === undefined ||
  (Array.isArray(value) &&
    value.every(
      (image) =>
        image &&
        typeof image === 'object' &&
        typeof (image as Record<string, unknown>).data === 'string' &&
        typeof (image as Record<string, unknown>).mimeType === 'string'
    ));

const isValidMessageInput = (sessionId: unknown, text: unknown, images: unknown): boolean =>
  isNonEmptyString(sessionId) &&
  typeof text === 'string' &&
  isValidImages(images) &&
  (text.length > 0 || (Array.isArray(images) && images.length > 0));

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
    (_event, sessionId: unknown, text: unknown, images?: unknown): AgentActionResult => {
      if (!isValidMessageInput(sessionId, text, images)) {
        return { ok: false, error: 'invalid prompt' };
      }
      return promptSession(
        sessionId as string,
        text as string,
        images as { data: string; mimeType: string }[] | undefined
      );
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.AGENT_STEER,
    (_event, sessionId: unknown, text: unknown, images?: unknown): AgentActionResult => {
      if (!isValidMessageInput(sessionId, text, images)) {
        return { ok: false, error: 'invalid steer' };
      }
      return steerSession(
        sessionId as string,
        text as string,
        images as { data: string; mimeType: string }[] | undefined
      );
    }
  );

  ipcMain.handle(IPC_CHANNELS.AGENT_ABORT, (_event, sessionId: unknown): AgentActionResult => {
    if (!isNonEmptyString(sessionId)) return { ok: false, error: 'invalid abort' };
    return abortSession(sessionId);
  });

  ipcMain.handle(IPC_CHANNELS.AGENT_SNAPSHOT, (): AgentActionResult => requestSnapshot());

  ipcMain.handle(IPC_CHANNELS.FILES_SEARCH, (_event, root: unknown, query: unknown) => {
    if (!isNonEmptyString(root) || typeof query !== 'string') return [];
    return searchFiles(root, query);
  });
}
