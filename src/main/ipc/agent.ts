import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { IPC_CHANNELS } from '@shared/types';
import type { AgentActionResult, AgentSpawnRequest, ThinkingLevel } from '@shared/types/agent';
import { THINKING_LEVELS } from '@shared/types/agent';
import { app, BrowserWindow, ipcMain } from 'electron';
import {
  abortSession,
  promptSession,
  requestSnapshot,
  setAgentEventListener,
  setSessionReasoning,
  setSessionThinking,
  spawnSession,
  steerSession,
} from '../services/agentHost';
import { searchFiles } from '../services/fileSearch';
import {
  importExternalSession,
  listExternalSessions,
  readExternalSession,
} from '../services/sessionImport';

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

  ipcMain.handle(
    IPC_CHANNELS.AGENT_SET_THINKING,
    (_event, sessionId: unknown, level: unknown): AgentActionResult => {
      if (!isNonEmptyString(sessionId) || !THINKING_LEVELS.includes(level as ThinkingLevel)) {
        return { ok: false, error: 'invalid thinking level' };
      }
      return setSessionThinking(sessionId, level as ThinkingLevel);
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.AGENT_SET_REASONING,
    (_event, sessionId: unknown, enabled: unknown, level?: unknown): AgentActionResult => {
      if (!isNonEmptyString(sessionId) || typeof enabled !== 'boolean') {
        return { ok: false, error: 'invalid reasoning input' };
      }
      if (level !== undefined && !THINKING_LEVELS.includes(level as ThinkingLevel)) {
        return { ok: false, error: 'invalid thinking level' };
      }
      return setSessionReasoning(sessionId, enabled, level as ThinkingLevel | undefined);
    }
  );

  ipcMain.handle(IPC_CHANNELS.FILES_SEARCH, (_event, root: unknown, query: unknown) => {
    if (!isNonEmptyString(root) || typeof query !== 'string') return [];
    return searchFiles(root, query);
  });

  // 读取单个文件内容（edit diff 用于还原上下文与行号）。超大文件返回 null 兜底
  ipcMain.handle(IPC_CHANNELS.FILES_READ, (_event, filePath: unknown): string | null => {
    if (!isNonEmptyString(filePath)) return null;
    try {
      const stat = statSync(filePath);
      if (!stat.isFile() || stat.size > 2_000_000) return null;
      return readFileSync(filePath, 'utf8');
    } catch {
      return null;
    }
  });

  ipcMain.handle(IPC_CHANNELS.SESSIONS_SCAN_EXTERNAL, (_event, projectPath: unknown) => {
    if (!isNonEmptyString(projectPath)) return [];
    return listExternalSessions(projectPath);
  });

  ipcMain.handle(
    IPC_CHANNELS.SESSIONS_READ_EXTERNAL,
    (_event, sourceId: unknown, sessionPath: unknown) => {
      if (!isNonEmptyString(sourceId) || !isNonEmptyString(sessionPath)) return [];
      return readExternalSession(sourceId, sessionPath);
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.SESSIONS_IMPORT_EXTERNAL,
    (_event, sourceId: unknown, sessionPath: unknown, projectPath: unknown) => {
      if (
        !isNonEmptyString(sourceId) ||
        !isNonEmptyString(sessionPath) ||
        !isNonEmptyString(projectPath)
      ) {
        return null;
      }
      const sessionDir = path.join(app.getPath('userData'), 'agent', 'sessions');
      return importExternalSession(sourceId, sessionPath, projectPath, sessionDir);
    }
  );
}
