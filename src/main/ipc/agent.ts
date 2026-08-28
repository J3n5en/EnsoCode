import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { IPC_CHANNELS } from '@shared/types';
import type {
  AgentActionResult,
  AgentSpawnRequest,
  ApprovalDecision,
  ApprovalMode,
  ThinkingLevel,
} from '@shared/types/agent';
import { APPROVAL_MODES, THINKING_LEVELS } from '@shared/types/agent';
import { app, BrowserWindow, ipcMain } from 'electron';
import {
  abortSession,
  dismissCoworker,
  promptSession,
  requestSnapshot,
  respondApproval,
  respondAsk,
  rewindSession,
  setAgentEventListener,
  setSessionApprovalMode,
  setSessionReasoning,
  setSessionThinking,
  spawnCoworkerSession,
  spawnSession,
  steerSession,
  stopBackgroundTask,
} from '../services/agentHost';
import { searchFiles } from '../services/fileSearch';
import { maybeNotify } from '../services/notifications';
import { forwardAgentEvent } from '../services/pairHost';
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
    maybeNotify(event);
    // 手机第二屏：按订阅过滤后加密下发（host 在 main，不依赖窗口焦点）
    forwardAgentEvent(event);
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
    IPC_CHANNELS.AGENT_ASK_RESPOND,
    (_event, sessionId: unknown, requestId: unknown, answer: unknown): AgentActionResult => {
      if (
        !isNonEmptyString(sessionId) ||
        !isNonEmptyString(requestId) ||
        !isNonEmptyString(answer)
      ) {
        return { ok: false, error: 'invalid ask response' };
      }
      return respondAsk(sessionId, requestId, answer);
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.AGENT_SPAWN_COWORKER,
    (
      _event,
      parentSessionId: unknown,
      coworkerId: unknown,
      name: unknown,
      agentType: unknown,
      resumeFile: unknown
    ): AgentActionResult => {
      if (
        !isNonEmptyString(parentSessionId) ||
        !isNonEmptyString(coworkerId) ||
        !isNonEmptyString(name)
      ) {
        return { ok: false, error: 'invalid spawn-coworker' };
      }
      return spawnCoworkerSession(
        parentSessionId,
        coworkerId,
        name,
        typeof agentType === 'string' && agentType ? agentType : undefined,
        typeof resumeFile === 'string' && resumeFile ? resumeFile : undefined
      );
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.AGENT_DISMISS_COWORKER,
    (_event, parentSessionId: unknown, coworkerId: unknown, notify: unknown): AgentActionResult => {
      if (!isNonEmptyString(parentSessionId) || !isNonEmptyString(coworkerId)) {
        return { ok: false, error: 'invalid dismiss-coworker' };
      }
      return dismissCoworker(parentSessionId, coworkerId, notify === true);
    }
  );

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

  ipcMain.handle(
    IPC_CHANNELS.AGENT_APPROVAL_RESPOND,
    (_event, sessionId: unknown, requestId: unknown, decision: unknown): AgentActionResult => {
      if (
        !isNonEmptyString(sessionId) ||
        !isNonEmptyString(requestId) ||
        (decision !== 'allow' && decision !== 'allowSession' && decision !== 'deny')
      ) {
        return { ok: false, error: 'invalid approval response' };
      }
      return respondApproval(sessionId, requestId, decision as ApprovalDecision);
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.AGENT_SET_APPROVAL_MODE,
    (_event, sessionId: unknown, mode: unknown): AgentActionResult => {
      if (!isNonEmptyString(sessionId) || !APPROVAL_MODES.includes(mode as ApprovalMode)) {
        return { ok: false, error: 'invalid approval mode' };
      }
      return setSessionApprovalMode(sessionId, mode as ApprovalMode);
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.AGENT_REWIND,
    (
      _event,
      sessionId: unknown,
      userIndexFromEnd: unknown,
      restoreFiles: unknown
    ): AgentActionResult => {
      if (
        !isNonEmptyString(sessionId) ||
        typeof userIndexFromEnd !== 'number' ||
        userIndexFromEnd < 0 ||
        (restoreFiles !== undefined && typeof restoreFiles !== 'boolean')
      ) {
        return { ok: false, error: 'invalid rewind' };
      }
      return rewindSession(sessionId, userIndexFromEnd, restoreFiles);
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.AGENT_TASK_STOP,
    (_event, sessionId: unknown, taskId: unknown): AgentActionResult => {
      if (!isNonEmptyString(sessionId) || !isNonEmptyString(taskId)) {
        return { ok: false, error: 'invalid task stop' };
      }
      return stopBackgroundTask(sessionId, taskId);
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
