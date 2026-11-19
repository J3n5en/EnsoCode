import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { app, ipcMain } from '@platform';
import { checkAvatarImage } from '@shared/bots/cardPng';
import { proposalCardTitle } from '@shared/secretary/contact';
import { parseFeedQuery } from '@shared/secretary/feed';
import { IPC_CHANNELS } from '@shared/types';
import type { AttachedImage } from '@shared/types/agent';
import type { SecretarySkillView, SecretaryState } from '@shared/types/secretary';
import { notifyDesktop } from '../services/desktopHooks';
import { interruptedTurnReason } from '../services/interruptedTurns';
import { setSecretaryAvatarResolver } from '../services/localImageProtocol';
import { readStoredOauthCredentialKeys } from '../services/oauthProviders';
import { onConversationsMerged } from '../services/remoteRenderer/conversationSync';
import { broadcastToRenderers, isMainRenderer, isSettingsRenderer } from '../services/renderers';
import { appendAudit } from '../services/secretary/audit';
import { secretaryTool } from '../services/secretary/customTools';
import { buildDaily, parseDailyRequest, secretaryDailyPorts } from '../services/secretary/daily';
import { appendDailyRecord } from '../services/secretary/dailyLog';
import { mainSessionDefaultsFor } from '../services/secretary/defaults';
import {
  buildSecretaryState,
  dismissResult,
  listTakeovers,
  listUntracked,
  markResult,
  mutateTodo,
  pageSecretaryFeed,
  resolveProposal,
  revokeTakeover,
  secretaryDispatchPorts,
  setProposalAcceptedListener,
  setSecretaryForgetListener,
  setSecretaryStateListener,
  startPendingDispatches,
  stopLeftoverTasks,
  untrack,
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
import { openSecretaryTarget } from '../services/secretary/links';
import { secretaryProfile } from '../services/secretary/profile';
import {
  parseDismissRequest,
  parseMarkResultRequest,
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
import {
  readGlobalSkillBody,
  readSecretarySkill,
  secretarySkill,
  secretarySkillsDir,
  secretarySkillViews,
  withGlobalSkillEnabled,
  withOwnSkillEnabled,
} from '../services/secretary/skills';
import { SecretaryStore } from '../services/secretary/store';
import {
  getSourceAuthorityRegistry,
  isRootSessionAlive,
  observedBackgroundTasks,
  observedSessionStatus,
  observedSubagentsRunning,
  promptRootFromMain,
  releaseRootFromMain,
  resumeRootFromMain,
  setSecretaryDriverObserver,
  spawnRootFromMain,
} from './agent';
import { createSecretaryContact, type SecretaryContact } from './secretaryContact';
import {
  patchConversationsState,
  readPersistedConversation,
  readPersistedConversations,
  readSettingsState,
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
    createWorktree: async (conversationId, projectId, base) => {
      const created = await createConversationWorktree(conversationId, projectId, base);
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
  audit: (entry) => appendAudit(path.join(app.getPath('userData'), 'secretary'), entry),
  now: () => Date.now(),
  requestWatch: () => {
    const now = Date.now();
    host?.recordBackgroundStalls(driver?.watch(now) ?? [], now);
  },
};

let driver: DispatchDriver | null = null;
let host: SecretaryHost | null = null;
let contact: SecretaryContact | null = null;

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
  saveTodos: (todos) => {
    secretaryStore().saveTodos(todos);
  },
  schedules: () => secretaryStore().schedules(),
  saveSchedules: (schedules) => {
    secretaryStore().saveSchedules(schedules);
  },
  notify: (build) => void notifyDesktop().notifySecretary(build),
  // 联系方式在 registerSecretaryHandlers 里建：这里用 getter 拿到当前实例
  get contact() {
    return contact?.service;
  },
  isSecretaryConversation: (conversationId) => isSecretaryConversation(conversationId),
  publish: () => broadcastState(),
  now: () => Date.now(),
  backgroundStalls: (now) => driver?.watch(now) ?? [],
  tasks: (conversationId) => observedBackgroundTasks(conversationId),
  subagentsRunning: (conversationId) => observedSubagentsRunning(conversationId),
  // 上次应用退出打断这一轮：启动恢复时把原因写进回传，别报成失败
  interruptDetail: (conversationId) =>
    interruptedTurnReason(path.join(app.getPath('userData'), 'agent'), conversationId),
  startPending: (pendingIds, now) => {
    void startPendingDispatches(secretaryDispatchPorts, pendingIds, now).catch((error: unknown) => {
      console.warn(
        '[secretary] pending dispatch failed:',
        error instanceof Error ? error.message : String(error)
      );
    });
  },
  newId: () => randomUUID(),
  audit: (entry) => appendAudit(path.join(app.getPath('userData'), 'secretary'), entry),
  recordDaily: (entry) => appendDailyRecord(path.join(app.getPath('userData'), 'secretary'), entry),
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

/**
 * 待确认的卡与手机同步：新卡推一条带按钮的提示，处理掉的卡把按钮清掉。
 * 同一张卡只推一次由联系方式服务自己记着。
 */
function syncWaitingCards(state: SecretaryState): void {
  const pending = Object.values(state.proposals).filter(
    (proposal) => proposal.status === 'pending'
  );
  contact?.service.syncPendingCards(
    pending.map((proposal) => {
      const title = proposalCardTitle(proposal);
      return {
        id: proposal.id,
        kind: proposal.kind,
        conversationId: proposal.secretaryConversationId,
        ...(title ? { title } : {}),
      };
    })
  );
}

/** 聊天卡片与工作台读同一份 Main 状态 */
function broadcastState(): void {
  void secretaryState()
    .then((state) => {
      broadcastToRenderers(IPC_CHANNELS.SECRETARY_STATE_CHANGED, state);
      syncWaitingCards(state);
    })
    .catch(() => undefined);
}

/** 设置里的全局 skill：坏条目跳过，路径只认这里给出的 */
function globalSkillEntries(): { id: string; name: string; description: string; path: string }[] {
  const raw = readSettingsState()?.skills;
  if (!Array.isArray(raw)) return [];
  const entries: { id: string; name: string; description: string; path: string }[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const record = item as Record<string, unknown>;
    const id = typeof record.id === 'string' ? record.id : '';
    const name = typeof record.name === 'string' ? record.name : '';
    const skillPath = typeof record.path === 'string' ? record.path : '';
    if (!id || !name || !skillPath) continue;
    entries.push({
      id,
      name,
      description: typeof record.description === 'string' ? record.description : '',
      path: skillPath,
    });
  }
  return entries;
}

/** 设置页与右侧面板共用的一份 skill 视图 */
function skillViews(): SecretarySkillView[] {
  const profile = secretaryStore().profile();
  return secretarySkillViews({
    own: secretarySkill.list(),
    disabledOwn: profile?.disabledSkillNames ?? [],
    global: globalSkillEntries(),
    enabledGlobalIds: profile?.skillIds ?? [],
  });
}

function parseSkillRequest(
  value: unknown
): { id: string; source: 'own' | 'global'; enabled: boolean } | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const id = typeof record.id === 'string' ? record.id.trim() : '';
  const source = record.source;
  if (!id || (source !== 'own' && source !== 'global')) return null;
  if (record.enabled !== undefined && typeof record.enabled !== 'boolean') return null;
  return { id, source, enabled: record.enabled !== false };
}

/** skill 删掉后不再记在停用名单里：名单只留真实存在的目录 */
async function forgetDisabledSkill(name: string): Promise<void> {
  const profile = secretaryStore().profile();
  if (!profile?.disabledSkillNames?.includes(name)) return;
  await secretaryProfile.save(
    { disabledSkillNames: profile.disabledSkillNames.filter((entry) => entry !== name) },
    null
  );
}

export function registerSecretaryHandlers(): void {
  setSecretaryStateListener(broadcastState);
  // 停止会话后撤掉续跑与看门狗：驱动者与派发模块互相不认识，只在这里接上
  setSecretaryForgetListener((conversationId) => driver?.forget(conversationId));
  setSecretaryAvatarResolver(() => (secretaryEnabled() ? secretaryStore().avatarPath() : null));
  driver = createDispatchDriver(driverPorts);
  host = createSecretaryHost(hostPorts);
  // 用户点确认后立刻把「已确认，正在执行」投给秘书，不等下一分钟的 tick
  setProposalAcceptedListener(() => host?.flushNow());
  contact = createSecretaryContact({
    dir: () => path.join(app.getPath('userData'), 'secretary'),
    delivery: hostPorts,
    profile: () => secretaryStore().profile(),
    publish: broadcastState,
    // 确认卡在手机上确认时走与界面同一条路径；审批不在这个入口
    resolveProposal: (proposalId, action) =>
      resolveProposal(secretaryDispatchPorts, proposalId, action),
    // 「在应用里打开」：与深链同一条路，聚焦窗口并把工作台滚到那张卡
    openInApp: (target) => openSecretaryTarget(target),
  });
  contact.register();
  // 上次已经绑过就接着轮询；没绑过什么也不做
  void contact.start();
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

  ipcMain.handle(IPC_CHANNELS.SECRETARY_FEED, async (event, request: unknown) => {
    if (!isMainRenderer(event.sender.id)) return { ok: false, error: 'invalid sender' };
    if (!secretaryEnabled()) return { ok: false, error: 'disabled' };
    const query = parseFeedQuery(request);
    if (!query) return { ok: false, error: 'invalid request' };
    const page = await pageSecretaryFeed(secretaryDispatchPorts, query);
    return { ok: true, events: page.events, hasMore: page.hasMore };
  });

  // 按天回看：日期由 renderer 传本地日历日，Main 只认 YYYY-MM-DD
  ipcMain.handle(IPC_CHANNELS.SECRETARY_DAILY, async (event, request: unknown) => {
    if (!isMainRenderer(event.sender.id)) return { ok: false, error: 'invalid sender' };
    if (!secretaryEnabled()) return { ok: false, error: 'disabled' };
    const day = parseDailyRequest(request, Date.now());
    if (!day) return { ok: false, error: 'invalid request' };
    return { ok: true, daily: await buildDaily(secretaryDailyPorts, day) };
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

  ipcMain.handle(IPC_CHANNELS.SECRETARY_MARK_RESULT, async (event, request: unknown) => {
    if (!isMainRenderer(event.sender.id)) return { ok: false, error: 'invalid sender' };
    if (!secretaryEnabled()) return { ok: false, error: 'disabled' };
    const parsed = parseMarkResultRequest(request);
    if (!parsed) return { ok: false, error: 'invalid request' };
    return markResult(secretaryDispatchPorts, parsed.conversationId, parsed.action);
  });

  // 看板上的「停止遗留任务」：只停这条派发记录里还在跑的后台任务
  ipcMain.handle(IPC_CHANNELS.SECRETARY_STOP_TASKS, async (event, request: unknown) => {
    if (!isMainRenderer(event.sender.id)) return { ok: false, error: 'invalid sender' };
    if (!secretaryEnabled()) return { ok: false, error: 'disabled' };
    const parsed = parseDismissRequest(request);
    if (!parsed) return { ok: false, error: 'invalid request' };
    return stopLeftoverTasks(secretaryDispatchPorts, parsed.conversationId);
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

  ipcMain.handle(IPC_CHANNELS.SECRETARY_UNTRACKED_LIST, async (event) => {
    if (!isProfileEditor(event.sender.id)) return { ok: false, error: 'invalid sender' };
    return { ok: true, untracked: await listUntracked(secretaryDispatchPorts) };
  });

  // 移除只是恢复范围权限，不建立接管记录，开关关着也允许
  ipcMain.handle(IPC_CHANNELS.SECRETARY_UNTRACKED_REMOVE, async (event, request: unknown) => {
    if (!isProfileEditor(event.sender.id)) return { ok: false, error: 'invalid sender' };
    const parsed = parseDismissRequest(request);
    if (!parsed) return { ok: false, error: 'invalid request' };
    return untrack(secretaryDispatchPorts, parsed.conversationId);
  });

  ipcMain.handle(IPC_CHANNELS.SECRETARY_SCHEDULES_LIST, async (event) => {
    if (!isProfileEditor(event.sender.id)) return { ok: false, error: 'invalid sender' };
    if (!secretaryEnabled()) return { ok: false, error: 'disabled' };
    return { ok: true, schedules: listSchedules(secretarySchedulePorts) };
  });

  ipcMain.handle(IPC_CHANNELS.SECRETARY_SKILLS_LIST, async (event) => {
    if (!isProfileEditor(event.sender.id)) return { ok: false, error: 'invalid sender' };
    if (!secretaryEnabled()) return { ok: false, error: 'disabled' };
    return { ok: true, skills: skillViews() };
  });

  ipcMain.handle(IPC_CHANNELS.SECRETARY_SKILL_DELETE, async (event, request: unknown) => {
    if (!isProfileEditor(event.sender.id)) return { ok: false, error: 'invalid sender' };
    if (!secretaryEnabled()) return { ok: false, error: 'disabled' };
    const removed = await secretarySkill.remove(request, null);
    if (removed.ok) await forgetDisabledSkill(removed.name);
    return removed;
  });

  ipcMain.handle(IPC_CHANNELS.SECRETARY_SKILL_SET_ENABLED, async (event, request: unknown) => {
    if (!isProfileEditor(event.sender.id)) return { ok: false, error: 'invalid sender' };
    if (!secretaryEnabled()) return { ok: false, error: 'disabled' };
    const parsed = parseSkillRequest(request);
    if (!parsed) return { ok: false, error: 'invalid request' };
    const profile = secretaryStore().profile();
    if (!profile) return { ok: false, error: 'not-configured' };
    const draft =
      parsed.source === 'own'
        ? {
            disabledSkillNames: withOwnSkillEnabled(
              profile.disabledSkillNames ?? [],
              parsed.id,
              parsed.enabled
            ),
          }
        : { skillIds: withGlobalSkillEnabled(profile.skillIds ?? [], parsed.id, parsed.enabled) };
    return secretaryProfile.save(draft, null);
  });

  ipcMain.handle(IPC_CHANNELS.SECRETARY_SKILL_READ, async (event, request: unknown) => {
    if (!isProfileEditor(event.sender.id)) return { ok: false, error: 'invalid sender' };
    if (!secretaryEnabled()) return { ok: false, error: 'disabled' };
    const parsed = parseSkillRequest(request);
    if (!parsed) return { ok: false, error: 'invalid request' };
    if (parsed.source === 'own') {
      const skill = readSecretarySkill(secretarySkillsDir(), parsed.id);
      return skill ? { ok: true, body: skill.body } : { ok: false, error: 'not-found' };
    }
    // 路径只从设置里的权威条目取，renderer 传的 id 不是路径
    const entry = globalSkillEntries().find((skill) => skill.id === parsed.id);
    const body = entry ? readGlobalSkillBody(entry.path) : null;
    return body === null ? { ok: false, error: 'not-found' } : { ok: true, body };
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
