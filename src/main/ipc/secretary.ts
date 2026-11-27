import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { app, ipcMain } from '@platform';
import { proposalCardTitle } from '@shared/secretary/contact';
import { parseFeedQuery } from '@shared/secretary/feed';
import type { AttachedImage } from '@shared/types/agent';
import { IPC_CHANNELS } from '@shared/types/ipc';
import type { SecretarySkillView, SecretaryState, SecretarySummary } from '@shared/types/secretary';
import { resumesAfterQuit } from '../services/agentHost';
import { backgroundTaskStates } from '../services/backgroundTaskTracker';
import { coldResumedSessionIds, onColdResumeFailed } from '../services/coldRestart';
import { getDemandThreadStore } from '../services/demandThreads';
import { notifyDesktop } from '../services/desktopHooks';
import { getEventClaimStore } from '../services/eventClaims';
import { interruptedTurnReason } from '../services/interruptedTurns';
import { setSecretaryAvatarResolver } from '../services/localImageProtocol';
import { readStoredOauthCredentialKeys } from '../services/oauthProviders';
import { setRemoteSecretaryIdProvider } from '../services/remoteRenderer';
import { onConversationsMerged } from '../services/remoteRenderer/conversationSync';
import { broadcastToRenderers, isMainRenderer } from '../services/renderers';
import { appendAudit } from '../services/secretary/audit';
import { managerOfSync } from '../services/secretary/crossSecretary';
import { secretaryToolFor } from '../services/secretary/customTools';
import { buildDaily, dailyPortsFor, parseDailyRequest } from '../services/secretary/daily';
import { appendDailyRecord } from '../services/secretary/dailyLog';
import { mainSessionDefaultsFor } from '../services/secretary/defaults';
import { resolveTarget } from '../services/secretary/deliveries';
import {
  answerNeedsUser,
  buildSecretaryState,
  dismissPending,
  dismissResult,
  dispatchPortsFor,
  escalateNeedsUser,
  listTakeovers,
  listUntracked,
  loadPendingAttachments,
  markResult,
  mutateTodo,
  pageSecretaryFeed,
  resolveProposal,
  revokeTakeover,
  setProposalAcceptedListener,
  setSecretaryForgetListener,
  setSecretaryStateListener,
  startPendingDispatches,
  stopLeftoverTasks,
  untrack,
} from '../services/secretary/dispatch';
import { doneReportFor } from '../services/secretary/doneReport';
import {
  createDispatchDriver,
  type DispatchDriver,
  type DispatchDriverPorts,
  type GoalAction,
} from '../services/secretary/driver';
import { secretaryEnabled } from '../services/secretary/enabled';
import { verifyDispatchedGoalResult } from '../services/secretary/goalResultVerify';
import {
  ensureHomeConversation,
  type HomeConversationResult,
} from '../services/secretary/homeConversation';
import {
  createSecretaryHost,
  type SecretaryHost,
  type SecretaryHostPorts,
} from '../services/secretary/host';
import { isSecretaryConversation } from '../services/secretary/identity';
import {
  deletePreview,
  deleteSecretary,
  transferConversation,
} from '../services/secretary/lifecycle';
import { openSecretaryTarget } from '../services/secretary/links';
import { reportPeerTodos, setPeerDeliveryListener } from '../services/secretary/peers';
import { secretaryProfileFor } from '../services/secretary/profile';
import { projectAliasesFromSettings } from '../services/secretary/projectLabel';
import {
  cancelQueuedSession,
  createQueuedSessions,
  type QueuedSessionPorts,
  requestQueuedDrain,
  setQueuedSessions,
  startQueuedSession,
} from '../services/secretary/queuedSessions';
import { getSecretaryReportStore } from '../services/secretary/reportImages';
import {
  parseAvatarRequest,
  parseDismissPendingRequest,
  parseDismissRequest,
  parseMarkResultRequest,
  parseQueuedStartRequest,
  parseReferenceRequest,
  parseResolveProposalRequest,
  parseTodoMutateRequest,
  referenceConversations,
} from '../services/secretary/requests';
import { listSchedules, removeSchedule, schedulePortsFor } from '../services/secretary/schedules';
import {
  notifySecretariesChanged,
  resolveSecretaryRequest,
  type SecretaryContext,
  secretaryContext,
  secretaryContexts,
  secretaryIdOfConversation,
  secretaryIds,
  secretaryRegistry,
  secretaryRoot,
} from '../services/secretary/secretaries';
import {
  createSecretaryConversationFromMain,
  createSessionFromMain,
  type MainSessionRequest,
  type MainSessionResult,
  type SessionFactoryPorts,
} from '../services/secretary/sessionFactory';
import {
  readGlobalSkillBody,
  readSecretarySkill,
  secretarySkillFor,
  secretarySkillsDir,
  secretarySkillViews,
  withGlobalSkillEnabled,
  withOwnSkillEnabled,
} from '../services/secretary/skills';
import { createStatePublisher } from '../services/secretary/statePublisher';
import { SecretaryStore } from '../services/secretary/store';
import { readSessionReminders } from '../services/sessionReminders';
import { reseatUpstreamWaiters } from '../services/upstreamRecovery';
import { deleteUntouchedSessionBranch } from '../services/worktree/service';
import {
  getSourceAuthorityRegistry,
  getUpstreamRecoveryService,
  hasRestartResumingSubagent,
  isRootSessionAlive,
  observedBackgroundTasks,
  observedOwnSessionStatus,
  observedSessionStatus,
  observedSubagentsRunning,
  promptRootFromMain,
  releaseRootFromMain,
  resumeRootFromMain,
  rootImageInput,
  setSecretaryDriverObserver,
  setUpstreamSessionWakeHandler,
  spawnRootFromMain,
} from './agent';
import { createSecretaryContacts, type SecretaryContacts } from './secretaryContact';
import { createSecretaryTriggers, type SecretaryTriggers } from './secretaryTriggers';
import {
  patchConversationsState,
  readPersistedConversation,
  readPersistedConversations,
  readSettings,
  readSettingsState,
} from './settings';
import { createConversationWorktree, removeRegisteredWorktree } from './worktree';

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0;

/** 建会话与启动排队会话共用：除了默认模型都一样 */
function conversationPorts(): Omit<SessionFactoryPorts, 'defaults'> {
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
    prompt: (id, text, deliveryId, images) => promptRootFromMain(id, text, deliveryId, images),
    imageInput: (id) => rootImageInput(id),
    newId: () => randomUUID(),
    now: () => Date.now(),
  };
}

function sessionFactoryPorts(credentialKeys: ReadonlySet<string>): SessionFactoryPorts {
  return {
    ...conversationPorts(),
    defaults: (projectId) => mainSessionDefaultsFor(projectId, credentialKeys),
  };
}

function queuedOwner(ctx: SecretaryContext) {
  return { id: ctx.id, dispatch: dispatchPortsFor(ctx) };
}

function queuedSessionPorts(): QueuedSessionPorts {
  const conversations = conversationPorts();
  return {
    launch: conversations,
    rows: () => readPersistedConversations(),
    updateRow: (id, update) => {
      const written: { row: Record<string, unknown> | null } = { row: null };
      patchConversationsState((state) => {
        const row = state.conversations[id];
        const next = row ? update(row) : null;
        if (!next) return;
        state.conversations[id] = next;
        written.row = next;
      });
      return written.row;
    },
    // 取消排队：没跑过的会话，分支还停在基线上就一起删掉，同名分支能马上重新派发
    removeWorktree: async (record) => {
      await conversations.removeWorktree(record);
      await deleteUntouchedSessionBranch(record);
    },
    removeRow: conversations.removeRow,
    removeConversation: conversations.removeConversation,
    owner: (secretaryId) => {
      const ctx = secretaryContext(secretaryId);
      return ctx ? queuedOwner(ctx) : null;
    },
    owners: () => secretaryContexts().map(queuedOwner),
    maxTotal: () => secretaryRegistry().maxRunningTotal(),
    loadAttachments: (paths) => loadPendingAttachments(paths),
    flush: (secretaryId) => hosts.get(secretaryId)?.flushNow(),
    agentStarted: (id) => Boolean(getSourceAuthorityRegistry()?.conversation(id)?.sessionFile),
    now: () => Date.now(),
    newId: () => randomUUID(),
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

/** 秘书还没有会话时由 Main 建一条：联系渠道、定时、同事消息共用，同一个秘书只建一条 */
function startHomeConversation(ctx: SecretaryContext): Promise<HomeConversationResult> {
  return ensureHomeConversation(ctx.id, {
    existing: () => resolveTarget(hostPortsFor(ctx)),
    create: async () => {
      if (!secretaryEnabled()) return { ok: false, error: 'disabled' };
      const projectId = secretaryContext(ctx.id)?.projectId;
      if (!projectId) return { ok: false, error: 'secretary not found' };
      let credentialKeys: ReadonlySet<string>;
      try {
        credentialKeys = await readStoredOauthCredentialKeys();
      } catch {
        return { ok: false, error: 'model credentials unavailable' };
      }
      const created = await createSecretaryConversationFromMain(
        sessionFactoryPorts(credentialKeys),
        { projectId, title: new SecretaryStore(ctx.dir).profile()?.name.trim() || 'Secretary' }
      );
      appendAudit(ctx.dir, {
        at: Date.now(),
        secretaryConversationId: created.ok ? created.conversationId : null,
        op: 'secretary_conversation_start',
        ok: created.ok,
        ...(created.ok ? {} : { detail: created.error }),
      });
      if (created.ok) broadcastState();
      return created;
    },
  });
}

function disabledState(): SecretaryState {
  return {
    secretaryId: null,
    enabled: false,
    projectId: null,
    profile: null,
    persona: '',
    board: { needsYou: [], running: [], done: [], todos: [] },
    proposals: {},
    takeovers: [],
  };
}

/** 派出会话的审计记在管着它的那个秘书目录里；谁都不管时记在根目录 */
function auditDirFor(conversationId: string | null): string {
  if (conversationId) {
    const owner = managerOfSync(conversationId, readPersistedConversations());
    const ctx = owner ? secretaryContext(owner) : null;
    if (ctx) return ctx.dir;
  }
  return secretaryRoot();
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
  ownStatus: (conversationId) => observedOwnSessionStatus(conversationId),
  subagentsRunning: (conversationId) => observedSubagentsRunning(conversationId),
  alive: (conversationId) => isRootSessionAlive(conversationId),
  prompt: (conversationId, delivery, deliveryId) =>
    promptRootFromMain(
      conversationId,
      delivery.text,
      deliveryId,
      delivery.images as AttachedImage[] | undefined
    ),
  newId: () => randomUUID(),
  audit: (entry) => appendAudit(auditDirFor(entry.targetId ?? null), entry),
  now: () => Date.now(),
  requestWatch: () => {
    const now = Date.now();
    const stalls = driver?.watch(now) ?? [];
    for (const instance of hosts.values()) instance.recordBackgroundStalls(stalls, now);
  },
};

let driver: DispatchDriver | null = null;

/** 派发模块挂目标用：驱动者在注册 handler 时才建好，不能静态依赖 */
export function getDispatchDriver(): DispatchDriver | null {
  return driver;
}
let contacts: SecretaryContacts | null = null;
let triggers: SecretaryTriggers | null = null;
/** 每个秘书一个回传宿主：各自的定时器、巡检、投递槽位与定时任务 */
const hosts = new Map<string, SecretaryHost>();
/** 各秘书宿主对冷启动续跑失败的订阅 */
const resumeFailureSubscriptions = new Map<string, () => void>();

/** 界面上报的当前打开的会话；undefined 表示还没上报（刚启动），这时按上次落盘的 activeId 算 */
let viewedSession: string | null | undefined;

function viewedConversation(): string | null {
  if (viewedSession !== undefined) return viewedSession;
  const store = readSettings()?.['enso-conversations'] as
    | { state?: { activeId?: unknown } }
    | undefined;
  return typeof store?.state?.activeId === 'string' ? store.state.activeId : null;
}

/** 当前打开的会话变了：补判以前自动归档的派出会话要不要收回 */
export function onViewedConversationChanged(sessionId: string | null): void {
  viewedSession = sessionId;
  for (const instance of hosts.values()) instance.sweepAutoArchive();
}

/** 档案与定时在主界面的设置页里编辑 */
function isProfileEditor(webContentsId: number): boolean {
  return isMainRenderer(webContentsId);
}

/** 一个秘书的回传宿主端口：读写全部同步，读改写之间不留 await */
function hostPortsFor(
  ctx: SecretaryContext
): SecretaryHostPorts & Required<Pick<SecretaryHostPorts, 'startConversation'>> {
  const store = () => new SecretaryStore(ctx.dir);
  const dispatchPorts = dispatchPortsFor(ctx);
  return {
    enabled: () => secretaryEnabled(),
    file: () => store().dispatch(),
    peekFile: () => store().dispatchView(),
    save: (file) => {
      store().saveDispatch(file);
    },
    rows: () => readPersistedConversations(),
    conversations: () => getSourceAuthorityRegistry()?.projection().conversations ?? [],
    projects: () => getSourceAuthorityRegistry()?.projection().projects ?? [],
    projectAliases: () => projectAliasesFromSettings(readSettings()),
    status: (conversationId) => observedSessionStatus(conversationId),
    alive: (conversationId) => isRootSessionAlive(conversationId),
    prompt: (conversationId, text, deliveryId) =>
      promptRootFromMain(conversationId, text, deliveryId),
    resume: (conversationId) => resumeRootFromMain(conversationId),
    // 回落只在这个秘书自己的会话里找，结果不会投到别的秘书那里
    secretaryProjectId: () => ctx.projectId,
    startConversation: () => startHomeConversation(ctx),
    profile: () => store().profile(),
    todos: () => store().todos(),
    saveTodos: (todos) => {
      store().saveTodos(todos);
    },
    schedules: () => store().schedules(),
    saveSchedules: (schedules) => {
      store().saveSchedules(schedules);
    },
    notify: (build) => void notifyDesktop().notifySecretary(build, ctx.dir),
    // 联系方式按秘书各一份：这里用 getter 拿到当前实例
    get contact() {
      return contacts?.service(ctx.id);
    },
    isSecretaryConversation: (conversationId) =>
      secretaryIdOfConversation(conversationId) === ctx.id,
    answerNeedsUser: (link, answer, askedAt) => {
      void answerNeedsUser(dispatchPorts, link, answer, askedAt).catch((error: unknown) => {
        console.warn(
          '[secretary] needsUser answer failed:',
          error instanceof Error ? error.message : String(error)
        );
      });
    },
    escalateNeedsUser: (link, text) => {
      escalateNeedsUser(dispatchPorts, link, text, 'ask');
    },
    publish: () => broadcastState(),
    now: () => Date.now(),
    backgroundStalls: (now) => driver?.watch(now) ?? [],
    tasks: (conversationId) => observedBackgroundTasks(conversationId),
    tasksReported: () => backgroundTaskStates.reported(),
    subagentsRunning: (conversationId) => observedSubagentsRunning(conversationId),
    reminders: (conversationId) => readSessionReminders(conversationId),
    // 上次应用退出打断这一轮：启动恢复时把原因写进回传，别报成失败
    interruptDetail: (conversationId) =>
      interruptedTurnReason(path.join(app.getPath('userData'), 'agent'), conversationId),
    // 写进恢复清单的会话新实例接着跑：退出与冷启动恢复都不报失败、中断
    continuesAfterExit: (conversationId) => resumesAfterQuit(conversationId),
    coldResumed: (conversationId) =>
      coldResumedSessionIds().has(conversationId) || hasRestartResumingSubagent(conversationId),
    startPending: (pendingIds, now) => {
      void startPendingDispatches(dispatchPorts, pendingIds, now).catch((error: unknown) => {
        console.warn(
          '[secretary] pending dispatch failed:',
          error instanceof Error ? error.message : String(error)
        );
      });
    },
    drainQueued: () => requestQueuedDrain(),
    reportPeerTodos: () => reportPeerTodos(ctx),
    archive: (conversationId, at) => {
      patchConversationsState((state) => {
        const row = state.conversations[conversationId];
        if (!row || row.archived === true) return;
        state.conversations[conversationId] = { ...row, archived: true, archivedAt: at };
      });
    },
    unarchive: (conversationId) => {
      patchConversationsState((state) => {
        const row = state.conversations[conversationId];
        if (!row) return;
        const { archived: _archived, archivedAt: _archivedAt, ...rest } = row;
        state.conversations[conversationId] = rest;
      });
    },
    viewed: (conversationId) => viewedConversation() === conversationId,
    newId: () => randomUUID(),
    audit: (entry) => appendAudit(ctx.dir, entry),
    recordDaily: (entry) => appendDailyRecord(ctx.dir, entry),
    archiveReport: (conversationId, at, text, extra) =>
      void getSecretaryReportStore()?.archive(conversationId, at, text, extra),
    verifyGoalResult: (conversationId, result) =>
      verifyDispatchedGoalResult(conversationId, result),
  };
}

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

async function secretaryState(ctx: SecretaryContext): Promise<SecretaryState> {
  const enabled = secretaryEnabled();
  const state = await buildSecretaryState(dispatchPortsFor(ctx), {
    enabled,
    projectId: enabled ? ctx.projectId : null,
  });
  const schedulesRev = createHash('sha1')
    .update(JSON.stringify(new SecretaryStore(ctx.dir).schedules()))
    .digest('hex')
    .slice(0, 12);
  return { ...state, secretaryId: ctx.id, schedulesRev };
}

function secretarySummaries(): SecretarySummary[] {
  return secretaryRegistry()
    .list()
    .flatMap((entry) => {
      const ctx = secretaryContext(entry.id);
      if (!ctx) return [];
      const profile = new SecretaryStore(ctx.dir).profile();
      return [
        {
          id: ctx.id,
          projectId: ctx.projectId,
          name: profile?.name ?? null,
          avatar: profile?.avatar ?? null,
          order: entry.order,
        },
      ];
    });
}

/**
 * 待确认的卡与手机同步：新卡推一条带按钮的提示，处理掉的卡把按钮清掉。
 * 同一张卡只推一次由联系方式服务自己记着；每个秘书只推自己的卡。
 */
function syncWaitingCards(secretaryId: string, state: SecretaryState): void {
  const pending = Object.values(state.proposals).filter(
    (proposal) => proposal.status === 'pending'
  );
  contacts?.service(secretaryId)?.syncPendingCards(
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

const publishList = createStatePublisher({
  build: async () => secretarySummaries(),
  emit: (list) => broadcastToRenderers(IPC_CHANNELS.SECRETARY_LIST_CHANGED, list),
  intervalMs: 300,
});
const statePublishers = new Map<string, () => void>();

function statePublisherFor(ctx: SecretaryContext): () => void {
  let publish = statePublishers.get(ctx.id);
  if (!publish) {
    publish = createStatePublisher({
      // 删除后可能还有一次尾随发布：秘书不在了就不发
      build: () =>
        secretaryContext(ctx.id) ? secretaryState(ctx) : Promise.reject(new Error('gone')),
      emit: (state) => {
        broadcastToRenderers(IPC_CHANNELS.SECRETARY_STATE_CHANGED, state);
        syncWaitingCards(ctx.id, state);
      },
      intervalMs: 300,
    });
    statePublishers.set(ctx.id, publish);
  }
  return publish;
}

/** 聊天卡片与工作台读同一份 Main 状态：每个秘书各自节流推一份，清单单独推 */
function broadcastState(): void {
  publishList();
  for (const ctx of secretaryContexts()) statePublisherFor(ctx)();
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
function skillViews(ctx: SecretaryContext): SecretarySkillView[] {
  const profile = new SecretaryStore(ctx.dir).profile();
  return secretarySkillViews({
    own: secretarySkillFor(ctx).list(),
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
async function forgetDisabledSkill(ctx: SecretaryContext, name: string): Promise<void> {
  const profile = new SecretaryStore(ctx.dir).profile();
  if (!profile?.disabledSkillNames?.includes(name)) return;
  await secretaryProfileFor(ctx).save(
    { disabledSkillNames: profile.disabledSkillNames.filter((entry) => entry !== name) },
    null
  );
}

/** 提案 id 全局随机：在各秘书的文件里找它属于谁 */
function secretaryOfProposal(proposalId: string): SecretaryContext | null {
  for (const ctx of secretaryContexts()) {
    if (Object.hasOwn(new SecretaryStore(ctx.dir).dispatch().proposals, proposalId)) return ctx;
  }
  return null;
}

/** 等待表里有这条派发的秘书 */
function secretaryOfPending(pendingId: string): SecretaryContext | null {
  for (const ctx of secretaryContexts()) {
    const pending = new SecretaryStore(ctx.dir).dispatch().pending;
    if (pending && Object.hasOwn(pending, pendingId)) return ctx;
  }
  return null;
}

/** 管着这个会话的秘书：按派发 / 接管记录找；都没有时按请求里的秘书 */
function secretaryOfRecord(conversationId: string, requested: unknown): SecretaryContext | null {
  for (const ctx of secretaryContexts()) {
    if (Object.hasOwn(new SecretaryStore(ctx.dir).dispatch().dispatched, conversationId))
      return ctx;
  }
  return resolveSecretaryRequest(requested);
}

function resolveProposalAnywhere(
  proposalId: string,
  action: 'confirm' | 'reject',
  edits?: Parameters<typeof resolveProposal>[3],
  profileDraft?: Parameters<typeof resolveProposal>[4]
): ReturnType<typeof resolveProposal> {
  const ctx = secretaryOfProposal(proposalId);
  if (!ctx) return Promise.resolve({ ok: false, error: 'not-found' });
  return resolveProposal(dispatchPortsFor(ctx), proposalId, action, edits, profileDraft);
}

/** 起一个秘书：回传宿主与联系方式 */
async function startSecretary(ctx: SecretaryContext): Promise<void> {
  if (!hosts.has(ctx.id)) {
    const created = createSecretaryHost(hostPortsFor(ctx));
    hosts.set(ctx.id, created);
    created.start();
    // 续跑没接上的照常报失败；宿主晚于冷启动续跑起来，订阅时补报已失败的
    resumeFailureSubscriptions.set(
      ctx.id,
      onColdResumeFailed((conversationId, error) =>
        created.onRestartResumeFailed(conversationId, error)
      )
    );
  }
  await contacts?.add(ctx);
}

const NO_SECRETARY = { ok: false as const, error: 'secretary-required' };

export function registerSecretaryHandlers(): void {
  setSecretaryStateListener(broadcastState);
  // 远端主界面接入/续连时补发秘书重读通知，丢失过推送的远端自愈
  setRemoteSecretaryIdProvider(() => secretaryIds());
  getEventClaimStore().onChanged(broadcastState);
  getDemandThreadStore().onChanged(broadcastState);
  // worker 报完启动时的任务表：启动时没敢判的、以前自动归档仍有任务在跑的会话在这里补判收回
  backgroundTaskStates.onReported(() => {
    for (const instance of hosts.values()) instance.sweepAutoArchive();
  });
  // 停止会话后撤掉续跑与看门狗：驱动者与派发模块互相不认识，只在这里接上
  setSecretaryForgetListener((conversationId) => driver?.forget(conversationId));
  setSecretaryAvatarResolver((secretaryId) => {
    if (!secretaryEnabled()) return null;
    const ctx = resolveSecretaryRequest(secretaryId ?? undefined);
    return ctx ? new SecretaryStore(ctx.dir).avatarPath() : null;
  });
  // 同事发来的消息：让收件秘书的宿主立刻试投
  setPeerDeliveryListener((secretaryId) => hosts.get(secretaryId)?.flushNow());
  driver = createDispatchDriver({
    ...driverPorts,
    upstreamRecovery: getUpstreamRecoveryService() ?? undefined,
    providerOf: (conversationId) => {
      const row = readPersistedConversation(conversationId);
      if (typeof row?.lastProviderId === 'string' && row.lastProviderId) return row.lastProviderId;
      return getSourceAuthorityRegistry()?.conversation(conversationId)?.selection?.providerId;
    },
  });
  setUpstreamSessionWakeHandler((conversationId, reason) => {
    const outcome = driver?.wakeUpstream(conversationId, reason);
    // delivered / dropped 都按「已处理」交给布尔语义：dropped 时返回 false，
    // 让 Main 回落到 renderer 广播（desktop 会话的 waiting 不在驱动者这里）
    if (outcome === 'retry') return 'retry';
    return outcome === 'delivered';
  });
  // 重启后闸门内存是空的：把磁盘上还挂着 waiting(upstream) 的会话重新登记，
  // 沿用 since/attempt 退避进度，倒计时到点真正发起重试——否则卡片永远「等待上游恢复」却无人重试
  {
    const recovery = getUpstreamRecoveryService();
    if (recovery) {
      reseatUpstreamWaiters(recovery, readPersistedConversations(), Date.now());
    }
  }
  const queued = createQueuedSessions(queuedSessionPorts());
  setQueuedSessions(queued);
  // 用户点确认或提案执行完立刻投给秘书，不等下一分钟的 tick
  setProposalAcceptedListener(() => {
    for (const instance of hosts.values()) instance.flushNow();
  });
  contacts = createSecretaryContacts({
    delivery: (ctx) => hostPortsFor(ctx),
    publish: broadcastState,
    // 确认卡在手机上确认时走与界面同一条路径；审批不在这个入口
    resolveProposal: (proposalId, action) => resolveProposalAnywhere(proposalId, action),
    // 「在应用里打开」：与深链同一条路，聚焦窗口并把工作台滚到那张卡
    openInApp: (target) => openSecretaryTarget(target),
  });
  contacts.register();
  triggers = createSecretaryTriggers({
    onEnqueued: (secretaryId, deliverAt) => {
      hosts.get(secretaryId)?.scheduleFlush(deliverAt);
      broadcastState();
    },
  });
  triggers.register();
  app.once('before-quit', () => {
    void triggers?.stop();
  });
  // 同一次 observe 的结果既给驱动也给每个秘书的回传宿主，事件入口只调一次
  setSecretaryDriverObserver((event, changes) => {
    driver?.observe(event);
    for (const instance of hosts.values()) instance.onAgentEvent(event, changes);
    contacts?.observeAgentEvent(event);
    // 改了名字或人设的会话等本轮跑完再释放，免得打断正在跑的一轮
    if (event.type === 'turn-completed' || event.type === 'turn-failed') {
      const sessionId = 'identity' in event && event.identity ? event.identity.sessionId : null;
      const ctx = sessionId ? secretaryContext(secretaryIdOfConversation(sessionId) ?? '') : null;
      if (sessionId && ctx) void secretaryProfileFor(ctx).onTurnEnded(sessionId);
    }
  });
  onConversationsMerged((patch) => {
    driver?.onConversationsMerged(patch);
    // 会话被删：排队位次变了，也可能删的是占着名额的会话
    if (patch.removes.length > 0) requestQueuedDrain();
  });
  // 上次已经绑过就接着轮询；没绑过什么也不做
  void contacts.start().then(async () => {
    // 先收尾上次认领中的排队会话，再起宿主：已起来的按运行中记，宿主恢复时照常报中断
    queued.recover();
    for (const ctx of secretaryContexts()) await startSecretary(ctx);
    requestQueuedDrain();
    await triggers?.start();
  });

  ipcMain.handle(IPC_CHANNELS.SECRETARY_LIST, async (event) => {
    if (!isProfileEditor(event.sender.id)) return [];
    return secretaryEnabled() ? secretarySummaries() : [];
  });

  ipcMain.handle(IPC_CHANNELS.SECRETARY_CREATE, async (event) => {
    if (!isProfileEditor(event.sender.id)) return { ok: false, error: 'invalid sender' };
    if (!secretaryEnabled()) return { ok: false, error: 'disabled' };
    let entry: { id: string };
    try {
      entry = secretaryRegistry().create();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { ok: false, error: message.includes('limit') ? 'limit' : message };
    }
    const ctx = secretaryContext(entry.id);
    if (!ctx) return { ok: false, error: 'not-found' };
    appendAudit(ctx.dir, {
      at: Date.now(),
      secretaryConversationId: null,
      op: 'secretary_create',
      ok: true,
    });
    await startSecretary(ctx);
    notifySecretariesChanged();
    broadcastState();
    return { ok: true, secretaryId: ctx.id, projectId: ctx.projectId };
  });

  ipcMain.handle(IPC_CHANNELS.SECRETARY_DELETE_PREVIEW, async (event, secretaryId: unknown) => {
    if (!isProfileEditor(event.sender.id)) return { ok: false, error: 'invalid sender' };
    const ctx = typeof secretaryId === 'string' ? secretaryContext(secretaryId) : null;
    if (!ctx) return { ok: false, error: 'not-found' };
    return { ok: true, preview: await deletePreview(ctx, contacts?.service(ctx.id)) };
  });

  ipcMain.handle(IPC_CHANNELS.SECRETARY_DELETE, async (event, request: unknown) => {
    if (!isProfileEditor(event.sender.id)) return { ok: false, error: 'invalid sender' };
    const parsed =
      request && typeof request === 'object' && !Array.isArray(request)
        ? (request as Record<string, unknown>)
        : {};
    const ctx =
      typeof parsed.secretaryId === 'string' ? secretaryContext(parsed.secretaryId) : null;
    if (!ctx) return { ok: false, error: 'not-found' };
    // 二次确认：界面先拿预览、用户再点一次确认，才会带上这个标记
    if (parsed.confirmed !== true) return { ok: false, error: 'confirmation-required' };
    const result = await deleteSecretary(ctx, {
      forget: (conversationId) => driver?.forget(conversationId),
      stop: async () => {
        hosts.get(ctx.id)?.stop();
        hosts.delete(ctx.id);
        resumeFailureSubscriptions.get(ctx.id)?.();
        resumeFailureSubscriptions.delete(ctx.id);
        statePublishers.delete(ctx.id);
        await contacts?.remove(ctx.id, true);
        await triggers?.onSecretaryRemoved(ctx.id);
      },
    });
    notifySecretariesChanged();
    broadcastState();
    return result;
  });

  ipcMain.handle(IPC_CHANNELS.SECRETARY_TRANSFER, async (event, request: unknown) => {
    if (!isMainRenderer(event.sender.id)) return { ok: false, error: 'invalid sender' };
    if (!secretaryEnabled()) return { ok: false, error: 'disabled' };
    const parsed =
      request && typeof request === 'object' && !Array.isArray(request)
        ? (request as Record<string, unknown>)
        : {};
    if (!isNonEmptyString(parsed.conversationId) || !isNonEmptyString(parsed.toSecretaryId))
      return { ok: false, error: 'invalid request' };
    const result = await transferConversation(parsed.conversationId, parsed.toSecretaryId);
    if (result.ok) {
      hosts.get(parsed.toSecretaryId)?.flushNow();
      broadcastState();
    }
    return result;
  });

  ipcMain.handle(IPC_CHANNELS.SECRETARY_OVERVIEW, async (event) => {
    if (!isMainRenderer(event.sender.id)) return { ok: false, error: 'invalid sender' };
    if (!secretaryEnabled()) return { ok: false, error: 'disabled' };
    const boards = [];
    for (const ctx of secretaryContexts()) {
      const state = await secretaryState(ctx);
      boards.push({ secretaryId: ctx.id, name: state.profile?.name ?? null, board: state.board });
    }
    return { ok: true, boards };
  });

  ipcMain.handle(IPC_CHANNELS.SECRETARY_GET_STATE, async (event, secretaryId: unknown) => {
    if (!isMainRenderer(event.sender.id)) return disabledState();
    const ctx = resolveSecretaryRequest(secretaryId);
    if (!ctx) return disabledState();
    return secretaryState(ctx);
  });

  ipcMain.handle(
    IPC_CHANNELS.SECRETARY_FEED,
    async (event, request: unknown, secretaryId: unknown) => {
      if (!isMainRenderer(event.sender.id)) return { ok: false, error: 'invalid sender' };
      if (!secretaryEnabled()) return { ok: false, error: 'disabled' };
      const ctx = resolveSecretaryRequest(secretaryId);
      if (!ctx) return NO_SECRETARY;
      const query = parseFeedQuery(request);
      if (!query) return { ok: false, error: 'invalid request' };
      const page = await pageSecretaryFeed(dispatchPortsFor(ctx), query);
      return { ok: true, events: page.events, hasMore: page.hasMore };
    }
  );

  // 按天回看：日期由 renderer 传本地日历日，Main 只认 YYYY-MM-DD
  ipcMain.handle(
    IPC_CHANNELS.SECRETARY_DAILY,
    async (event, request: unknown, secretaryId: unknown) => {
      if (!isMainRenderer(event.sender.id)) return { ok: false, error: 'invalid sender' };
      if (!secretaryEnabled()) return { ok: false, error: 'disabled' };
      const ctx = resolveSecretaryRequest(secretaryId);
      if (!ctx) return NO_SECRETARY;
      const day = parseDailyRequest(request, Date.now());
      if (!day) return { ok: false, error: 'invalid request' };
      return { ok: true, daily: await buildDaily(dailyPortsFor(ctx), day) };
    }
  );

  ipcMain.handle(IPC_CHANNELS.SECRETARY_DONE_REPORT, async (event, conversationId: unknown) => {
    if (!isMainRenderer(event.sender.id)) return { ok: false, error: 'invalid sender' };
    if (!secretaryEnabled()) return { ok: false, error: 'disabled' };
    if (!isNonEmptyString(conversationId)) return { ok: false, error: 'invalid request' };
    return { ok: true, result: await doneReportFor(conversationId) };
  });

  // profile 为 null 就是还没完成初次设置：界面据此显示欢迎页
  ipcMain.handle(IPC_CHANNELS.SECRETARY_GET_PROFILE, async (event, secretaryId: unknown) => {
    if (!isProfileEditor(event.sender.id)) return { ok: false, error: 'invalid sender' };
    if (!secretaryEnabled()) return { ok: false, error: 'disabled' };
    const ctx = resolveSecretaryRequest(secretaryId);
    if (!ctx) return NO_SECRETARY;
    const store = new SecretaryStore(ctx.dir);
    return { ok: true, profile: store.profile(), persona: store.readPersona() };
  });

  ipcMain.handle(
    IPC_CHANNELS.SECRETARY_SAVE_PROFILE,
    async (event, request: unknown, secretaryId: unknown) => {
      if (!isProfileEditor(event.sender.id)) return { ok: false, error: 'invalid sender' };
      if (!secretaryEnabled()) return { ok: false, error: 'disabled' };
      const ctx = resolveSecretaryRequest(secretaryId);
      if (!ctx) return NO_SECRETARY;
      const saved = await secretaryProfileFor(ctx).save(request, null);
      if (saved.ok) broadcastState();
      return saved;
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.SECRETARY_RESET_PROFILE,
    async (event, request: unknown, secretaryId: unknown) => {
      if (!isProfileEditor(event.sender.id)) return { ok: false, error: 'invalid sender' };
      if (!secretaryEnabled()) return { ok: false, error: 'disabled' };
      const ctx = resolveSecretaryRequest(secretaryId);
      if (!ctx) return NO_SECRETARY;
      return secretaryProfileFor(ctx).reset(request, null);
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.SECRETARY_SET_AVATAR,
    async (event, request: unknown, secretaryId: unknown) => {
      if (!isProfileEditor(event.sender.id)) return { ok: false, error: 'invalid sender' };
      if (!secretaryEnabled()) return { ok: false, error: 'disabled' };
      const ctx = resolveSecretaryRequest(secretaryId);
      if (!ctx) return NO_SECRETARY;
      const parsed = parseAvatarRequest(request);
      if (!parsed) return { ok: false, error: 'invalid request' };
      const store = new SecretaryStore(ctx.dir);
      const hadImage = Boolean(store.profile()?.avatar.imageVersion);
      const profile = store.setAvatar(parsed.image);
      if (!profile) return { ok: false, error: 'not-configured' };
      appendAudit(ctx.dir, {
        at: Date.now(),
        secretaryConversationId: null,
        op: 'profile_avatar',
        ok: true,
        detail: parsed.image ? (hadImage ? 'replaced' : 'uploaded') : 'removed',
      });
      broadcastState();
      return { ok: true, profile };
    }
  );

  ipcMain.handle(IPC_CHANNELS.SECRETARY_RESOLVE_PROPOSAL, async (event, request: unknown) => {
    if (!isMainRenderer(event.sender.id)) return { ok: false, error: 'invalid sender' };
    if (!secretaryEnabled()) return { ok: false, error: 'disabled' };
    const parsed = parseResolveProposalRequest(request);
    if (!parsed) return { ok: false, error: 'invalid request' };
    return resolveProposalAnywhere(
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
      // 点名授权归这个秘书会话所属的秘书
      const ctx = secretaryContext(secretaryIdOfConversation(parsed.secretaryConversationId) ?? '');
      if (!ctx) return { ok: false, error: 'not-secretary' };
      return referenceConversations(dispatchPortsFor(ctx), parsed, isSecretaryConversation);
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.SECRETARY_TODO_MUTATE,
    async (event, request: unknown, secretaryId: unknown) => {
      if (!isMainRenderer(event.sender.id)) return { ok: false, error: 'invalid sender' };
      if (!secretaryEnabled()) return { ok: false, error: 'disabled' };
      const ctx = resolveSecretaryRequest(secretaryId);
      if (!ctx) return NO_SECRETARY;
      const parsed = parseTodoMutateRequest(request);
      if (!parsed) return { ok: false, error: 'invalid request' };
      return mutateTodo(dispatchPortsFor(ctx), parsed);
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.SECRETARY_DISMISS_RESULT,
    async (event, request: unknown, secretaryId: unknown) => {
      if (!isMainRenderer(event.sender.id)) return { ok: false, error: 'invalid sender' };
      if (!secretaryEnabled()) return { ok: false, error: 'disabled' };
      const parsed = parseDismissRequest(request);
      if (!parsed) return { ok: false, error: 'invalid request' };
      const ctx = secretaryOfRecord(parsed.conversationId, secretaryId);
      if (!ctx) return NO_SECRETARY;
      return dismissResult(dispatchPortsFor(ctx), parsed.conversationId);
    }
  );

  ipcMain.handle(IPC_CHANNELS.SECRETARY_DISMISS_PENDING, async (event, request: unknown) => {
    if (!isMainRenderer(event.sender.id)) return { ok: false, error: 'invalid sender' };
    if (!secretaryEnabled()) return { ok: false, error: 'disabled' };
    const parsed = parseDismissPendingRequest(request);
    if (!parsed) return { ok: false, error: 'invalid request' };
    const ctx = secretaryOfPending(parsed.pendingId);
    if (!ctx) return { ok: false, error: 'not-found' };
    return dismissPending(dispatchPortsFor(ctx), parsed.pendingId);
  });

  ipcMain.handle(
    IPC_CHANNELS.SECRETARY_MARK_RESULT,
    async (event, request: unknown, secretaryId: unknown) => {
      if (!isMainRenderer(event.sender.id)) return { ok: false, error: 'invalid sender' };
      if (!secretaryEnabled()) return { ok: false, error: 'disabled' };
      const parsed = parseMarkResultRequest(request);
      if (!parsed) return { ok: false, error: 'invalid request' };
      const ctx = secretaryOfRecord(parsed.conversationId, secretaryId);
      if (!ctx) return NO_SECRETARY;
      return markResult(dispatchPortsFor(ctx), parsed.conversationId, parsed.action);
    }
  );

  // 看板上的「停止遗留任务」：只停这条派发记录里还在跑的后台任务
  ipcMain.handle(
    IPC_CHANNELS.SECRETARY_STOP_TASKS,
    async (event, request: unknown, secretaryId: unknown) => {
      if (!isMainRenderer(event.sender.id)) return { ok: false, error: 'invalid sender' };
      if (!secretaryEnabled()) return { ok: false, error: 'disabled' };
      const parsed = parseDismissRequest(request);
      if (!parsed) return { ok: false, error: 'invalid request' };
      const ctx = secretaryOfRecord(parsed.conversationId, secretaryId);
      if (!ctx) return NO_SECRETARY;
      return stopLeftoverTasks(dispatchPortsFor(ctx), parsed.conversationId);
    }
  );

  // 撤销是收回权限，开关关着也允许
  ipcMain.handle(
    IPC_CHANNELS.SECRETARY_TAKEOVER_REVOKE,
    async (event, request: unknown, secretaryId: unknown) => {
      if (!isProfileEditor(event.sender.id)) return { ok: false, error: 'invalid sender' };
      const parsed = parseDismissRequest(request);
      if (!parsed) return { ok: false, error: 'invalid request' };
      const ctx = secretaryOfRecord(parsed.conversationId, secretaryId);
      if (!ctx) return NO_SECRETARY;
      return revokeTakeover(dispatchPortsFor(ctx), parsed.conversationId);
    }
  );

  /** 接管清单：会话界面与侧栏要看全部秘书的；设置页传秘书 id 只看它的 */
  ipcMain.handle(IPC_CHANNELS.SECRETARY_TAKEOVERS_LIST, async (event, secretaryId: unknown) => {
    if (!isProfileEditor(event.sender.id)) return { ok: false, error: 'invalid sender' };
    const contexts =
      typeof secretaryId === 'string'
        ? [secretaryContext(secretaryId)].filter((ctx): ctx is SecretaryContext => ctx !== null)
        : secretaryContexts();
    const takeovers = [];
    for (const ctx of contexts) takeovers.push(...(await listTakeovers(dispatchPortsFor(ctx))));
    return { ok: true, takeovers };
  });

  ipcMain.handle(IPC_CHANNELS.SECRETARY_UNTRACKED_LIST, async (event, secretaryId: unknown) => {
    if (!isProfileEditor(event.sender.id)) return { ok: false, error: 'invalid sender' };
    const ctx = resolveSecretaryRequest(secretaryId);
    if (!ctx) return NO_SECRETARY;
    return { ok: true, untracked: await listUntracked(dispatchPortsFor(ctx)) };
  });

  // 移除只是恢复范围权限，不建立接管记录，开关关着也允许
  ipcMain.handle(
    IPC_CHANNELS.SECRETARY_UNTRACKED_REMOVE,
    async (event, request: unknown, secretaryId: unknown) => {
      if (!isProfileEditor(event.sender.id)) return { ok: false, error: 'invalid sender' };
      const ctx = resolveSecretaryRequest(secretaryId);
      if (!ctx) return NO_SECRETARY;
      const parsed = parseDismissRequest(request);
      if (!parsed) return { ok: false, error: 'invalid request' };
      return untrack(dispatchPortsFor(ctx), parsed.conversationId);
    }
  );

  ipcMain.handle(IPC_CHANNELS.SECRETARY_SCHEDULES_LIST, async (event, secretaryId: unknown) => {
    if (!isProfileEditor(event.sender.id)) return { ok: false, error: 'invalid sender' };
    if (!secretaryEnabled()) return { ok: false, error: 'disabled' };
    const ctx = resolveSecretaryRequest(secretaryId);
    if (!ctx) return NO_SECRETARY;
    return { ok: true, schedules: listSchedules(schedulePortsFor(ctx)) };
  });

  ipcMain.handle(IPC_CHANNELS.SECRETARY_SKILLS_LIST, async (event, secretaryId: unknown) => {
    if (!isProfileEditor(event.sender.id)) return { ok: false, error: 'invalid sender' };
    if (!secretaryEnabled()) return { ok: false, error: 'disabled' };
    const ctx = resolveSecretaryRequest(secretaryId);
    if (!ctx) return NO_SECRETARY;
    return { ok: true, skills: skillViews(ctx) };
  });

  ipcMain.handle(
    IPC_CHANNELS.SECRETARY_SKILL_DELETE,
    async (event, request: unknown, secretaryId: unknown) => {
      if (!isProfileEditor(event.sender.id)) return { ok: false, error: 'invalid sender' };
      if (!secretaryEnabled()) return { ok: false, error: 'disabled' };
      const ctx = resolveSecretaryRequest(secretaryId);
      if (!ctx) return NO_SECRETARY;
      const removed = await secretarySkillFor(ctx).remove(request, null);
      if (removed.ok) await forgetDisabledSkill(ctx, removed.name);
      return removed;
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.SECRETARY_SKILL_SET_ENABLED,
    async (event, request: unknown, secretaryId: unknown) => {
      if (!isProfileEditor(event.sender.id)) return { ok: false, error: 'invalid sender' };
      if (!secretaryEnabled()) return { ok: false, error: 'disabled' };
      const ctx = resolveSecretaryRequest(secretaryId);
      if (!ctx) return NO_SECRETARY;
      const parsed = parseSkillRequest(request);
      if (!parsed) return { ok: false, error: 'invalid request' };
      const profile = new SecretaryStore(ctx.dir).profile();
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
          : {
              skillIds: withGlobalSkillEnabled(profile.skillIds ?? [], parsed.id, parsed.enabled),
            };
      return secretaryProfileFor(ctx).save(draft, null);
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.SECRETARY_SKILL_READ,
    async (event, request: unknown, secretaryId: unknown) => {
      if (!isProfileEditor(event.sender.id)) return { ok: false, error: 'invalid sender' };
      if (!secretaryEnabled()) return { ok: false, error: 'disabled' };
      const ctx = resolveSecretaryRequest(secretaryId);
      if (!ctx) return NO_SECRETARY;
      const parsed = parseSkillRequest(request);
      if (!parsed) return { ok: false, error: 'invalid request' };
      if (parsed.source === 'own') {
        const skill = readSecretarySkill(secretarySkillsDir(ctx), parsed.id);
        return skill ? { ok: true, body: skill.body } : { ok: false, error: 'not-found' };
      }
      // 路径只从设置里的权威条目取，renderer 传的 id 不是路径
      const entry = globalSkillEntries().find((skill) => skill.id === parsed.id);
      const body = entry ? readGlobalSkillBody(entry.path) : null;
      return body === null ? { ok: false, error: 'not-found' } : { ok: true, body };
    }
  );

  ipcMain.handle(IPC_CHANNELS.SECRETARY_TOOLS_LIST, async (event, secretaryId: unknown) => {
    if (!isProfileEditor(event.sender.id)) return { ok: false, error: 'invalid sender' };
    if (!secretaryEnabled()) return { ok: false, error: 'disabled' };
    const ctx = resolveSecretaryRequest(secretaryId);
    if (!ctx) return NO_SECRETARY;
    return { ok: true, tools: secretaryToolFor(ctx).list() };
  });

  ipcMain.handle(
    IPC_CHANNELS.SECRETARY_TOOL_DELETE,
    async (event, request: unknown, secretaryId: unknown) => {
      if (!isProfileEditor(event.sender.id)) return { ok: false, error: 'invalid sender' };
      if (!secretaryEnabled()) return { ok: false, error: 'disabled' };
      const ctx = resolveSecretaryRequest(secretaryId);
      if (!ctx) return NO_SECRETARY;
      return secretaryToolFor(ctx).remove(request, null);
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.SECRETARY_SCHEDULE_REMOVE,
    async (event, request: unknown, secretaryId: unknown) => {
      if (!isProfileEditor(event.sender.id)) return { ok: false, error: 'invalid sender' };
      if (!secretaryEnabled()) return { ok: false, error: 'disabled' };
      const ctx = resolveSecretaryRequest(secretaryId);
      if (!ctx) return NO_SECRETARY;
      const scheduleId = parseScheduleIdRequest(request);
      if (!scheduleId) return { ok: false, error: 'invalid request' };
      return removeSchedule(schedulePortsFor(ctx), scheduleId, { secretaryConversationId: null });
    }
  );

  // 派出会话已经存在时开关关闭也不能让它失去驱动者，所以这里只查发起方与行的归属
  ipcMain.handle(IPC_CHANNELS.SECRETARY_GOAL_ACTION, async (event, request: unknown) => {
    if (!isMainRenderer(event.sender.id)) return { ok: false, error: 'invalid sender' };
    const parsed = parseGoalAction(request);
    if (!parsed) return { ok: false, error: 'invalid request' };
    if (!driver) return { ok: false, error: 'driver unavailable' };
    return driver.goalAction(parsed.conversationId, parsed.action, parsed.text);
  });

  // 排队会话「立即开始」与取消：同样只查发起方，归属与状态由启动泵按盘上的行判
  ipcMain.handle(IPC_CHANNELS.SECRETARY_QUEUED_START, async (event, request: unknown) => {
    if (!isMainRenderer(event.sender.id)) return { ok: false, error: 'invalid sender' };
    const parsed = parseQueuedStartRequest(request);
    if (!parsed) return { ok: false, error: 'invalid request' };
    return startQueuedSession(parsed.conversationId, parsed.followUp);
  });

  ipcMain.handle(IPC_CHANNELS.SECRETARY_QUEUED_CANCEL, async (event, request: unknown) => {
    if (!isMainRenderer(event.sender.id)) return { ok: false, error: 'invalid sender' };
    const parsed = parseDismissRequest(request);
    if (!parsed) return { ok: false, error: 'invalid request' };
    return cancelQueuedSession(parsed.conversationId, null);
  });
}
