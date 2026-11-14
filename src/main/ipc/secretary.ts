import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { app, ipcMain } from '@platform';
import { checkAvatarImage } from '@shared/bots/cardPng';
import { IPC_CHANNELS } from '@shared/types';
import type { AttachedImage } from '@shared/types/agent';
import type { SecretaryState } from '@shared/types/secretary';
import { notifyDesktop } from '../services/desktopHooks';
import { setSecretaryAvatarResolver } from '../services/localImageProtocol';
import { readStoredOauthCredentialKeys } from '../services/oauthProviders';
import { onConversationsMerged } from '../services/remoteRenderer/conversationSync';
import { broadcastToRenderers, isMainRenderer, isSettingsRenderer } from '../services/renderers';
import { appendAudit } from '../services/secretary/audit';
import { secretaryTool } from '../services/secretary/customTools';
import { mainSessionDefaultsFor } from '../services/secretary/defaults';
import {
  buildSecretaryState,
  dismissResult,
  grantTakeover,
  listTakeovers,
  mutateTodo,
  resolveProposal,
  revokeTakeover,
  secretaryDispatchPorts,
  setSecretaryStateListener,
} from '../services/secretary/dispatch';
import {
  createDispatchDriver,
  type DispatchDriver,
  type DispatchDriverPorts,
  type GoalAction,
} from '../services/secretary/driver';
import { secretaryEnabled } from '../services/secretary/enabled';
import {
  createSecretaryHost,
  type SecretaryHost,
  type SecretaryHostPorts,
} from '../services/secretary/host';
import { isSecretaryConversation, secretaryProjectId } from '../services/secretary/identity';
import { secretaryProfile } from '../services/secretary/profile';
import {
  parseDismissRequest,
  parseReferenceRequest,
  parseResolveProposalRequest,
  parseTodoMutateRequest,
  referenceConversations,
} from '../services/secretary/requests';
import {
  listSchedules,
  removeSchedule,
  secretarySchedulePorts,
} from '../services/secretary/schedules';
import {
  createSessionFromMain,
  type MainSessionRequest,
  type MainSessionResult,
  type SessionFactoryPorts,
} from '../services/secretary/sessionFactory';
import { secretarySkill } from '../services/secretary/skills';
import { SecretaryStore } from '../services/secretary/store';
import {
  getSourceAuthorityRegistry,
  isRootSessionAlive,
  observedSessionStatus,
  promptRootFromMain,
  releaseRootFromMain,
  resumeRootFromMain,
  setSecretaryDriverObserver,
  spawnRootFromMain,
} from './agent';
import {
  patchConversationsState,
  readPersistedConversation,
  readPersistedConversations,
} from './settings';
import { createConversationWorktree, removeRegisteredWorktree } from './worktree';

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0;

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
    takeovers: [],
  };
}

const driverPorts: DispatchDriverPorts = {
  row: (conversationId) => readPersistedConversation(conversationId) ?? undefined,
  saveRuntime: (conversationId, runtime) => {
    patchConversationsState((state) => {
      const row = state.conversations[conversationId];
      if (!row) return;
      state.conversations[conversationId] = {
        ...row,
        queuedMessages: runtime.queued,
        ...(runtime.goal ? { goal: runtime.goal } : { goal: undefined }),
      };
    });
  },
  status: (conversationId) => observedSessionStatus(conversationId),
  alive: (conversationId) => isRootSessionAlive(conversationId),
  prompt: (conversationId, delivery, deliveryId) =>
    promptRootFromMain(
      conversationId,
      delivery.text,
      deliveryId,
      delivery.images as AttachedImage[] | undefined
    ),
  newId: () => randomUUID(),
};

let driver: DispatchDriver | null = null;
let host: SecretaryHost | null = null;

function secretaryStore(): SecretaryStore {
  return new SecretaryStore(path.join(app.getPath('userData'), 'secretary'));
}

/** 档案与定时在设置窗口里编辑，聊天侧的操作仍只认主界面 */
function isProfileEditor(webContentsId: number): boolean {
  return isMainRenderer(webContentsId) || isSettingsRenderer(webContentsId);
}

function parseAvatarRequest(value: unknown): { image: Uint8Array | null } | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const image = (value as { image?: unknown }).image;
  if (image === null) return { image: null };
  if (image instanceof Uint8Array && checkAvatarImage(image)) return { image };
  return null;
}

/** 回传宿主的 Main 侧能力：读写全部同步，读改写之间不留 await */
const hostPorts: SecretaryHostPorts = {
  enabled: () => secretaryEnabled(),
  file: () => secretaryStore().dispatch(),
  save: (file) => {
    secretaryStore().saveDispatch(file);
  },
  rows: () => readPersistedConversations(),
  conversations: () => getSourceAuthorityRegistry()?.projection().conversations ?? [],
  projects: () => getSourceAuthorityRegistry()?.projection().projects ?? [],
  status: (conversationId) => observedSessionStatus(conversationId),
  alive: (conversationId) => isRootSessionAlive(conversationId),
  prompt: (conversationId, text, deliveryId) =>
    promptRootFromMain(conversationId, text, deliveryId),
  resume: (conversationId) => resumeRootFromMain(conversationId),
  profile: () => secretaryStore().profile(),
  todos: () => secretaryStore().todos(),
  schedules: () => secretaryStore().schedules(),
  saveSchedules: (schedules) => {
    secretaryStore().saveSchedules(schedules);
  },
  notify: (build) => void notifyDesktop().notifySecretary(build),
  publish: () => broadcastState(),
  now: () => Date.now(),
  newId: () => randomUUID(),
};

function parseGoalAction(
  value: unknown
): { conversationId: string; action: GoalAction; text?: string } | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const request = value as Record<string, unknown>;
  if (!isNonEmptyString(request.conversationId)) return null;
  const action = request.action;
  if (action !== 'set' && action !== 'pause' && action !== 'resume' && action !== 'clear') {
    return null;
  }
  if (request.text !== undefined && typeof request.text !== 'string') return null;
  return {
    conversationId: request.conversationId,
    action,
    ...(typeof request.text === 'string' ? { text: request.text } : {}),
  };
}

function parseScheduleIdRequest(value: unknown): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const request = value as Record<string, unknown>;
  return isNonEmptyString(request.scheduleId) ? request.scheduleId : null;
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
  setSecretaryAvatarResolver(() => (secretaryEnabled() ? secretaryStore().avatarPath() : null));
  driver = createDispatchDriver(driverPorts);
  host = createSecretaryHost(hostPorts);
  // 同一次 observe 的结果既给驱动也给回传宿主，事件入口只调一次
  setSecretaryDriverObserver((event, changes) => {
    driver?.observe(event);
    host?.onAgentEvent(event, changes);
    // 改了名字或人设的会话等本轮跑完再释放，免得打断正在跑的一轮
    if (event.type === 'turn-completed' || event.type === 'turn-failed') {
      const sessionId = 'identity' in event && event.identity ? event.identity.sessionId : null;
      if (sessionId) void secretaryProfile.onTurnEnded(sessionId);
    }
  });
  onConversationsMerged((patch) => driver?.onConversationsMerged(patch));
  host.start();

  ipcMain.handle(IPC_CHANNELS.SECRETARY_GET_STATE, async (event) => {
    if (!isMainRenderer(event.sender.id)) return disabledState();
    return secretaryState();
  });

  // profile 为 null 就是还没完成初次设置：界面据此显示欢迎页
  ipcMain.handle(IPC_CHANNELS.SECRETARY_GET_PROFILE, async (event) => {
    if (!isProfileEditor(event.sender.id)) return { ok: false, error: 'invalid sender' };
    if (!secretaryEnabled()) return { ok: false, error: 'disabled' };
    const store = secretaryStore();
    return { ok: true, profile: store.profile(), persona: store.readPersona() };
  });

  ipcMain.handle(IPC_CHANNELS.SECRETARY_SAVE_PROFILE, async (event, request: unknown) => {
    if (!isProfileEditor(event.sender.id)) return { ok: false, error: 'invalid sender' };
    if (!secretaryEnabled()) return { ok: false, error: 'disabled' };
    return secretaryProfile.save(request, null);
  });

  ipcMain.handle(IPC_CHANNELS.SECRETARY_RESET_PROFILE, async (event, request: unknown) => {
    if (!isProfileEditor(event.sender.id)) return { ok: false, error: 'invalid sender' };
    if (!secretaryEnabled()) return { ok: false, error: 'disabled' };
    return secretaryProfile.reset(request, null);
  });

  ipcMain.handle(IPC_CHANNELS.SECRETARY_SET_AVATAR, async (event, request: unknown) => {
    if (!isProfileEditor(event.sender.id)) return { ok: false, error: 'invalid sender' };
    if (!secretaryEnabled()) return { ok: false, error: 'disabled' };
    const parsed = parseAvatarRequest(request);
    if (!parsed) return { ok: false, error: 'invalid request' };
    const store = secretaryStore();
    const hadImage = Boolean(store.profile()?.avatar.imageVersion);
    const profile = store.setAvatar(parsed.image);
    if (!profile) return { ok: false, error: 'not-configured' };
    appendAudit(path.join(app.getPath('userData'), 'secretary'), {
      at: Date.now(),
      secretaryConversationId: null,
      op: 'profile_avatar',
      ok: true,
      detail: parsed.image ? (hadImage ? 'replaced' : 'uploaded') : 'removed',
    });
    broadcastState();
    return { ok: true, profile };
  });

  ipcMain.handle(IPC_CHANNELS.SECRETARY_RESOLVE_PROPOSAL, async (event, request: unknown) => {
    if (!isMainRenderer(event.sender.id)) return { ok: false, error: 'invalid sender' };
    if (!secretaryEnabled()) return { ok: false, error: 'disabled' };
    const parsed = parseResolveProposalRequest(request);
    if (!parsed) return { ok: false, error: 'invalid request' };
    return resolveProposal(
      secretaryDispatchPorts,
      parsed.proposalId,
      parsed.action,
      parsed.edits,
      parsed.profileDraft
    );
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

  ipcMain.handle(IPC_CHANNELS.SECRETARY_DISMISS_RESULT, async (event, request: unknown) => {
    if (!isMainRenderer(event.sender.id)) return { ok: false, error: 'invalid sender' };
    if (!secretaryEnabled()) return { ok: false, error: 'disabled' };
    const parsed = parseDismissRequest(request);
    if (!parsed) return { ok: false, error: 'invalid request' };
    return dismissResult(secretaryDispatchPorts, parsed.conversationId);
  });

  // 授权只认主界面上用户亲手点的；秘书的工具调用走提案，到不了这里
  ipcMain.handle(IPC_CHANNELS.SECRETARY_TAKEOVER_GRANT, async (event, request: unknown) => {
    if (!isMainRenderer(event.sender.id)) return { ok: false, error: 'invalid sender' };
    if (!secretaryEnabled()) return { ok: false, error: 'disabled' };
    const parsed = parseDismissRequest(request);
    if (!parsed) return { ok: false, error: 'invalid request' };
    return grantTakeover(secretaryDispatchPorts, parsed.conversationId, 'user', null);
  });

  // 撤销是收回权限，开关关着也允许
  ipcMain.handle(IPC_CHANNELS.SECRETARY_TAKEOVER_REVOKE, async (event, request: unknown) => {
    if (!isProfileEditor(event.sender.id)) return { ok: false, error: 'invalid sender' };
    const parsed = parseDismissRequest(request);
    if (!parsed) return { ok: false, error: 'invalid request' };
    return revokeTakeover(
      secretaryDispatchPorts,
      parsed.conversationId,
      isSettingsRenderer(event.sender.id) ? 'settings' : 'session'
    );
  });

  ipcMain.handle(IPC_CHANNELS.SECRETARY_TAKEOVERS_LIST, async (event) => {
    if (!isProfileEditor(event.sender.id)) return { ok: false, error: 'invalid sender' };
    return { ok: true, takeovers: await listTakeovers(secretaryDispatchPorts) };
  });

  ipcMain.handle(IPC_CHANNELS.SECRETARY_SCHEDULES_LIST, async (event) => {
    if (!isProfileEditor(event.sender.id)) return { ok: false, error: 'invalid sender' };
    if (!secretaryEnabled()) return { ok: false, error: 'disabled' };
    return { ok: true, schedules: listSchedules(secretarySchedulePorts) };
  });

  ipcMain.handle(IPC_CHANNELS.SECRETARY_SKILLS_LIST, async (event) => {
    if (!isProfileEditor(event.sender.id)) return { ok: false, error: 'invalid sender' };
    if (!secretaryEnabled()) return { ok: false, error: 'disabled' };
    return { ok: true, skills: secretarySkill.list() };
  });

  ipcMain.handle(IPC_CHANNELS.SECRETARY_SKILL_DELETE, async (event, request: unknown) => {
    if (!isProfileEditor(event.sender.id)) return { ok: false, error: 'invalid sender' };
    if (!secretaryEnabled()) return { ok: false, error: 'disabled' };
    return secretarySkill.remove(request, null);
  });

  ipcMain.handle(IPC_CHANNELS.SECRETARY_TOOLS_LIST, async (event) => {
    if (!isProfileEditor(event.sender.id)) return { ok: false, error: 'invalid sender' };
    if (!secretaryEnabled()) return { ok: false, error: 'disabled' };
    return { ok: true, tools: secretaryTool.list() };
  });

  ipcMain.handle(IPC_CHANNELS.SECRETARY_TOOL_DELETE, async (event, request: unknown) => {
    if (!isProfileEditor(event.sender.id)) return { ok: false, error: 'invalid sender' };
    if (!secretaryEnabled()) return { ok: false, error: 'disabled' };
    return secretaryTool.remove(request, null);
  });

  ipcMain.handle(IPC_CHANNELS.SECRETARY_SCHEDULE_REMOVE, async (event, request: unknown) => {
    if (!isProfileEditor(event.sender.id)) return { ok: false, error: 'invalid sender' };
    if (!secretaryEnabled()) return { ok: false, error: 'disabled' };
    const scheduleId = parseScheduleIdRequest(request);
    if (!scheduleId) return { ok: false, error: 'invalid request' };
    return removeSchedule(secretarySchedulePorts, scheduleId, { secretaryConversationId: null });
  });

  // 派出会话已经存在时开关关闭也不能让它失去驱动者，所以这里只查发起方与行的归属
  ipcMain.handle(IPC_CHANNELS.SECRETARY_GOAL_ACTION, async (event, request: unknown) => {
    if (!isMainRenderer(event.sender.id)) return { ok: false, error: 'invalid sender' };
    const parsed = parseGoalAction(request);
    if (!parsed) return { ok: false, error: 'invalid request' };
    if (!driver) return { ok: false, error: 'driver unavailable' };
    return driver.goalAction(parsed.conversationId, parsed.action, parsed.text);
  });
}
