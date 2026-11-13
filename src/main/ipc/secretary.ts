import { randomUUID } from 'node:crypto';
import { app, ipcMain } from '@platform';
import { IPC_CHANNELS } from '@shared/types';
import type { SecretaryState } from '@shared/types/secretary';
import { readStoredOauthCredentialKeys } from '../services/oauthProviders';
import { broadcastToRenderers, isMainRenderer } from '../services/renderers';
import { mainSessionDefaultsFor } from '../services/secretary/defaults';
import {
  buildSecretaryState,
  mutateTodo,
  resolveProposal,
  secretaryDispatchPorts,
  setSecretaryStateListener,
} from '../services/secretary/dispatch';
import { secretaryEnabled } from '../services/secretary/enabled';
import { isSecretaryConversation, secretaryProjectId } from '../services/secretary/identity';
import {
  parseReferenceRequest,
  parseResolveProposalRequest,
  parseTodoMutateRequest,
  referenceConversations,
} from '../services/secretary/requests';
import {
  createSessionFromMain,
  type MainSessionRequest,
  type MainSessionResult,
  type SessionFactoryPorts,
} from '../services/secretary/sessionFactory';
import {
  getSourceAuthorityRegistry,
  promptRootFromMain,
  releaseRootFromMain,
  spawnRootFromMain,
} from './agent';
import { patchConversationsState } from './settings';
import { createConversationWorktree, removeRegisteredWorktree } from './worktree';

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0;

function parseDevCreateRequest(value: unknown): MainSessionRequest | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const request = value as Record<string, unknown>;
  if (!isNonEmptyString(request.projectId) || !isNonEmptyString(request.prompt)) return null;
  if (request.title !== undefined && typeof request.title !== 'string') return null;
  if (request.worktree !== undefined && typeof request.worktree !== 'boolean') return null;
  return {
    projectId: request.projectId,
    prompt: request.prompt,
    ...(typeof request.title === 'string' ? { title: request.title } : {}),
    worktree: request.worktree === true,
  };
}

function sessionFactoryPorts(credentialKeys: ReadonlySet<string>): SessionFactoryPorts {
  const authority = getSourceAuthorityRegistry();
  return {
    project: (id) => authority?.project(id),
    createConversation: (projectId, projectVersion) => {
      const created = authority?.createConversation({
        requestId: randomUUID(),
        projectId,
        projectVersion,
      });
      return created?.accepted ? created.value : undefined;
    },
    removeConversation: (id) => {
      const conversation = authority?.conversation(id);
      if (!conversation) return;
      authority?.removeConversation({
        requestId: randomUUID(),
        conversationId: id,
        version: conversation.version,
      });
    },
    defaults: (projectId) => mainSessionDefaultsFor(projectId, credentialKeys),
    createWorktree: async (conversationId, projectId) => {
      const created = await createConversationWorktree(conversationId, projectId);
      if (!created.ok) throw new Error(created.error);
      return created.value;
    },
    removeWorktree: (record) => removeRegisteredWorktree(record.conversationId, record),
    writeRow: (row) => {
      const id = String(row.id);
      patchConversationsState((state) => {
        state.conversations[id] = row;
        state.order = [id, ...state.order.filter((entry) => entry !== id)];
      });
    },
    removeRow: (id) => {
      patchConversationsState((state) => {
        delete state.conversations[id];
        state.order = state.order.filter((entry) => entry !== id);
      });
    },
    spawn: (request) => spawnRootFromMain(request),
    release: (id) => releaseRootFromMain(id),
    prompt: (id, text, deliveryId) => promptRootFromMain(id, text, deliveryId),
    newId: () => randomUUID(),
    now: () => Date.now(),
  };
}

/** 秘书派活建会话的唯一生产入口：凭据在 Main 现读 */
export async function createSessionViaMain(
  request: MainSessionRequest
): Promise<MainSessionResult> {
  let credentialKeys: ReadonlySet<string>;
  try {
    credentialKeys = await readStoredOauthCredentialKeys();
  } catch {
    return { ok: false, error: 'model credentials unavailable' };
  }
  return createSessionFromMain(sessionFactoryPorts(credentialKeys), request);
}

function disabledState(): SecretaryState {
  return {
    enabled: false,
    projectId: null,
    profile: null,
    persona: '',
    board: { needsYou: [], running: [], done: [], todos: [] },
    proposals: {},
  };
}

function secretaryState(): Promise<SecretaryState> {
  const enabled = secretaryEnabled();
  return buildSecretaryState(secretaryDispatchPorts, {
    enabled,
    projectId: enabled ? secretaryProjectId() : null,
  });
}

/** 聊天卡片与工作台读同一份 Main 状态 */
function broadcastState(): void {
  void secretaryState()
    .then((state) => broadcastToRenderers(IPC_CHANNELS.SECRETARY_STATE_CHANGED, state))
    .catch(() => undefined);
}

export function registerSecretaryHandlers(): void {
  setSecretaryStateListener(broadcastState);

  ipcMain.handle(IPC_CHANNELS.SECRETARY_GET_STATE, async (event) => {
    if (!isMainRenderer(event.sender.id)) return disabledState();
    return secretaryState();
  });

  ipcMain.handle(IPC_CHANNELS.SECRETARY_RESOLVE_PROPOSAL, async (event, request: unknown) => {
    if (!isMainRenderer(event.sender.id)) return { ok: false, error: 'invalid sender' };
    if (!secretaryEnabled()) return { ok: false, error: 'disabled' };
    const parsed = parseResolveProposalRequest(request);
    if (!parsed) return { ok: false, error: 'invalid request' };
    return resolveProposal(secretaryDispatchPorts, parsed.proposalId, parsed.action, parsed.edits);
  });

  ipcMain.handle(
    IPC_CHANNELS.SECRETARY_REFERENCE_CONVERSATIONS,
    async (event, request: unknown) => {
      if (!isMainRenderer(event.sender.id)) return { ok: false, error: 'invalid sender' };
      if (!secretaryEnabled()) return { ok: false, error: 'disabled' };
      const parsed = parseReferenceRequest(request);
      if (!parsed) return { ok: false, error: 'invalid request' };
      return referenceConversations(secretaryDispatchPorts, parsed, isSecretaryConversation);
    }
  );

  ipcMain.handle(IPC_CHANNELS.SECRETARY_TODO_MUTATE, async (event, request: unknown) => {
    if (!isMainRenderer(event.sender.id)) return { ok: false, error: 'invalid sender' };
    if (!secretaryEnabled()) return { ok: false, error: 'disabled' };
    const parsed = parseTodoMutateRequest(request);
    if (!parsed) return { ok: false, error: 'invalid request' };
    return mutateTodo(secretaryDispatchPorts, parsed);
  });

  // dev-only 测试入口：真机验证 Main 原生建会话，U10 删除
  if (app.isPackaged) return;
  ipcMain.handle(IPC_CHANNELS.SECRETARY_DEV_CREATE_SESSION, async (event, request: unknown) => {
    if (!isMainRenderer(event.sender.id)) return { ok: false, error: 'invalid sender' };
    if (!secretaryEnabled()) return { ok: false, error: 'disabled' };
    const parsed = parseDevCreateRequest(request);
    if (!parsed) return { ok: false, error: 'invalid request' };
    return createSessionViaMain(parsed);
  });
}
