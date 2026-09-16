import { randomUUID } from 'node:crypto';
import path from 'node:path';
import {
  BTW_DISABLED_TOOLS,
  btwModelCandidates,
  parseBtwAbortRequest,
  parseBtwDisposeRequest,
  parseBtwPromptRequest,
  parseBtwSpawnRequest,
} from '@shared/btw';
import { IPC_CHANNELS } from '@shared/types';
import { type SpawnModelConfig, TITLE_SUMMARY_MAX_CANDIDATES } from '@shared/types/agent';
import { app, ipcMain } from 'electron';
import { titleSummaryTimeoutMs } from '../../agent/titleSummary';
import {
  abortCompleteText,
  abortSession,
  completeText,
  isAgentWorkerReady,
  releaseParentSession,
  resolveModelSelection,
  spawnSession,
} from '../services/agentHost';
import { readStoredOauthCredentialKeys } from '../services/oauthProviders';
import { removeConversationSessionFiles } from '../services/sessionFileCleanup';
import { isMainWebContents } from '../windows/MainWindow';
import { getSourceAuthorityRegistry, resolveConversationWorkspace } from './agent';
import { agentSessionIndex } from './capabilities';
import { readSettings } from './settings';

function settingsState(): Record<string, unknown> | undefined {
  return (readSettings()?.['enso-settings'] as { state?: Record<string, unknown> } | undefined)
    ?.state;
}

export function registerBtwHandlers(): void {
  ipcMain.handle(IPC_CHANNELS.BTW_PROMPT, async (event, request: unknown) => {
    if (!isMainWebContents(event.sender.id)) return { ok: false, error: 'not authorized' };
    const parsed = parseBtwPromptRequest(request);
    if (!parsed) return { ok: false, error: 'invalid request' };
    if (!isAgentWorkerReady()) return { ok: false, error: 'Agent worker is not running.' };
    let credentialKeys: ReadonlySet<string>;
    try {
      credentialKeys = await readStoredOauthCredentialKeys();
    } catch {
      return { ok: false, error: 'model credentials unavailable' };
    }
    const candidates: SpawnModelConfig[] = [];
    for (const candidate of btwModelCandidates(settingsState(), parsed.sessionModel)) {
      const resolved = resolveModelSelection(
        candidate.providerId,
        candidate.modelId,
        credentialKeys
      );
      if (resolved.ok && resolved.selection) candidates.push(resolved.selection.config);
      if (candidates.length >= TITLE_SUMMARY_MAX_CANDIDATES) break;
    }
    if (candidates.length === 0) return { ok: false, error: 'no usable model' };
    try {
      const text = await completeText({
        requestId: parsed.requestId,
        systemPrompt: parsed.systemPrompt,
        userText: parsed.userText,
        candidates,
        timeoutMs: titleSummaryTimeoutMs(1),
        stream: true,
        reasoning: parsed.reasoningEnabled ? (parsed.thinkingLevel ?? 'medium') : 'off',
      });
      return { ok: true, text };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        ok: false,
        error: message,
        ...(message === 'aborted' ? { aborted: true } : {}),
      };
    }
  });

  ipcMain.handle(IPC_CHANNELS.BTW_ABORT, (event, request: unknown) => {
    if (!isMainWebContents(event.sender.id)) return { ok: false, error: 'not authorized' };
    const parsed = parseBtwAbortRequest(request);
    if (!parsed) return { ok: false, error: 'invalid request' };
    return abortCompleteText(parsed.requestId);
  });

  ipcMain.handle(IPC_CHANNELS.BTW_SPAWN, async (event, request: unknown) => {
    if (!isMainWebContents(event.sender.id)) return { ok: false, error: 'not authorized' };
    const parsed = parseBtwSpawnRequest(request);
    if (!parsed) return { ok: false, error: 'invalid request' };
    if (getSourceAuthorityRegistry()?.conversation(parsed.sessionId)) {
      return { ok: false, error: 'session id in use' };
    }
    const existing = agentSessionIndex.currentIdentity(parsed.sessionId);
    if (existing && 'parent' in existing) return { ok: false, error: 'session id in use' };
    const workspace = resolveConversationWorkspace(parsed.parentConversationId);
    if (!workspace) return { ok: false, error: 'parent conversation unavailable' };
    const identity =
      existing && !('parent' in existing)
        ? existing
        : { sessionId: parsed.sessionId, generation: randomUUID() };
    agentSessionIndex.prepareParent(identity);
    let credentialKeys: ReadonlySet<string>;
    try {
      credentialKeys = await readStoredOauthCredentialKeys();
    } catch {
      return { ok: false, error: 'model credentials unavailable' };
    }
    return spawnSession(
      identity,
      {
        sessionId: parsed.sessionId,
        providerId: parsed.providerId,
        modelId: parsed.modelId,
        cwd: workspace.cwd,
        reasoningEnabled: parsed.reasoningEnabled,
        thinkingLevel: parsed.thinkingLevel,
        approvalMode: parsed.approvalMode ?? 'full',
        ...(parsed.presetId ? { presetId: parsed.presetId } : {}),
        ...(parsed.loadLocalSkills === undefined
          ? {}
          : { loadLocalSkills: parsed.loadLocalSkills }),
      },
      credentialKeys,
      workspace.remote,
      workspace.projectId,
      {
        rolePrompt: parsed.rolePrompt,
        extraDisabledTools: BTW_DISABLED_TOOLS,
        omitDispatchTools: true,
      }
    );
  });

  ipcMain.handle(IPC_CHANNELS.BTW_DISPOSE, async (event, request: unknown) => {
    if (!isMainWebContents(event.sender.id)) return { ok: false, error: 'not authorized' };
    const parsed = parseBtwDisposeRequest(request);
    if (!parsed) return { ok: false, error: 'invalid request' };
    if (getSourceAuthorityRegistry()?.conversation(parsed.sessionId)) {
      return { ok: false, error: 'not a btw session' };
    }
    const identity = agentSessionIndex.currentIdentity(parsed.sessionId);
    if (identity && 'parent' in identity) return { ok: false, error: 'not a btw session' };
    const file =
      identity && !('parent' in identity) ? agentSessionIndex.sessionFile(identity) : undefined;
    if (identity && !('parent' in identity)) {
      abortSession(identity);
      await releaseParentSession(identity);
    }
    removeConversationSessionFiles({
      sessionDir: path.join(app.getPath('userData'), 'agent', 'sessions'),
      conversationId: parsed.sessionId,
      ...(file ? { sessionFile: file } : {}),
    });
    return { ok: true };
  });
}
