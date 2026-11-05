import { randomUUID } from 'node:crypto';
import type { CatalogEntry } from '@enso/pair';
import {
  catalogEntryFromPairSession,
  catalogQueued,
  patchCatalogEntry,
  upsertCatalogEntry,
} from '@shared/pair/headlessCatalog';
import {
  applyHeadlessQueueAction,
  emptyHeadlessRuntime,
  type HeadlessDelivery,
  type HeadlessSessionRuntime,
  onHeadlessIdle,
} from '@shared/pair/headlessQueue';
import { type PersistedPairConversation, planPairResume } from '@shared/pair/headlessResume';
import { splitPlanPrefix } from '@shared/planMode';
import {
  hasLiveGenerationWork,
  nextStallWatchAction,
  shouldAbortStalledGeneration,
} from '@shared/stallTimeout';
import { cleanTitleSummarySource, extractRepresentativeTitle } from '@shared/titleSource';
import type {
  AgentActionResult,
  AgentSpawnRequest,
  AttachedImage,
  RendererAgentEvent,
  TitleSummaryInput,
} from '@shared/types/agent';
import type { PairCreatedSession, PairQueueAction, PairSessionConfig } from '@shared/types/pair';
import { splitUnattendedPrefix } from '@shared/unattendedNote';
import { patchConversationsState, readPersistedConversation } from '../ipc/settings';
import { getPairCatalog, getPairProjects, mutatePairCatalog } from './pairHost';

export interface PairSessionHostAgent {
  isAlive(sessionId: string): boolean;
  requestSnapshot(sessionId: string): void;
  spawn(request: AgentSpawnRequest): Promise<{ ok: boolean; error?: string }>;
  prompt(sessionId: string, text: string, images?: AttachedImage[]): void;
  steer(sessionId: string, text: string, images?: AttachedImage[]): void;
  abort(sessionId: string): void;
  setModel(sessionId: string, providerId: string, modelId: string): void;
  setReasoning(sessionId: string, enabled: boolean, level?: string): void;
  setThinking(sessionId: string, level: string): void;
  compact(sessionId: string, instructions?: string): void;
  rewind(sessionId: string, userIndexFromEnd: number, restoreFiles?: boolean): void;
  retry(sessionId: string): void;
  stopTask(sessionId: string, taskId: string): void;
  stopSubagent(sessionId: string, agentId: string): void;
  createAuthority(sessionId: string, projectId: string): void;
  worktreePath(sessionId: string): string | undefined;
  worktreeMissing(sessionId: string): boolean;
  projectPath(projectId: string): string | undefined;
  loadLocalSkills(): boolean;
  summarizeTitle(
    sessionId: string,
    input: TitleSummaryInput,
    sessionModel?: { providerId: string; modelId: string }
  ): Promise<AgentActionResult>;
  /** 生成卡顿超时；<=0 关闭 */
  stallTimeoutMs(): number;
}

/** 无渲染器时接管 leader 的卡顿看门狗：心跳取最近事件与前台命令截止时间的较大者 */
interface StallBeat {
  at: number;
  deadline?: number;
  attempts: number;
  pendingRetry: boolean;
}

let agent: PairSessionHostAgent | null = null;
let headless = false;
const runtimes = new Map<string, HeadlessSessionRuntime>();
const pendingInterrupt = new Map<string, string>();
const beats = new Map<string, StallBeat>();
const titleBaselines = new Map<string, string>();
let stallTimer: ReturnType<typeof setInterval> | null = null;

export function configurePairSessionHost(next: PairSessionHostAgent): void {
  agent = next;
}

export function setPairHeadless(active: boolean): void {
  headless = active;
  if (stallTimer) clearInterval(stallTimer);
  stallTimer = null;
  beats.clear();
  titleBaselines.clear();
  if (!active) {
    runtimes.clear();
    pendingInterrupt.clear();
    return;
  }
  seedRuntimes();
  stallTimer = setInterval(stallTick, 1000);
  stallTimer.unref?.();
}

export function isPairHeadless(): boolean {
  return headless;
}

export function headlessIdleBlocks(): {
  queuedCount: number;
  pendingAskCount: number;
  pendingApprovalCount: number;
} {
  let queuedCount = 0;
  let pendingAskCount = 0;
  let pendingApprovalCount = 0;
  for (const runtime of runtimes.values()) {
    queuedCount += runtime.queued.length;
    pendingAskCount += runtime.pendingAsks;
    pendingApprovalCount += runtime.pendingApprovals;
  }
  return { queuedCount, pendingAskCount, pendingApprovalCount };
}

function runtimeOf(sessionId: string): HeadlessSessionRuntime {
  const current = runtimes.get(sessionId);
  if (current) return current;
  const seeded = emptyHeadlessRuntime();
  runtimes.set(sessionId, seeded);
  return seeded;
}

function setRuntime(sessionId: string, runtime: HeadlessSessionRuntime): void {
  runtimes.set(sessionId, runtime);
}

function persistRuntime(sessionId: string, runtime: HeadlessSessionRuntime): void {
  patchConversationsState((state) => {
    const current = state.conversations[sessionId];
    if (!current) return;
    state.conversations[sessionId] = {
      ...current,
      queuedMessages: runtime.queued,
      ...(runtime.goal ? { goal: runtime.goal } : { goal: undefined }),
    };
  });
}

function pushCatalog(sessionId: string, runtime: HeadlessSessionRuntime, extra?: object): void {
  mutatePairCatalog(
    (catalog) =>
      patchCatalogEntry(catalog, sessionId, {
        status: runtime.status,
        queued: catalogQueued(runtime.queued),
        ...(runtime.goal
          ? {
              goal: {
                text: runtime.goal.text,
                status: runtime.goal.status,
                ...(runtime.goal.note ? { note: runtime.goal.note } : {}),
                autoTurns: runtime.goal.autoTurns,
              },
            }
          : { goal: undefined }),
        ...extra,
      }) as CatalogEntry[]
  );
}

function deliver(sessionId: string, delivery: HeadlessDelivery): void {
  if (delivery.kind === 'steer') agent?.steer(sessionId, delivery.text, delivery.images);
  else agent?.prompt(sessionId, delivery.text, delivery.images);
}

function seedRuntimes(): void {
  runtimes.clear();
  for (const entry of getPairCatalog()) {
    const persisted = readPersistedConversation(entry.id);
    const queued = Array.isArray(persisted?.queuedMessages)
      ? persisted.queuedMessages.filter(
          (
            item
          ): item is {
            id: string;
            text: string;
            images?: HeadlessSessionRuntime['queued'][number]['images'];
          } =>
            Boolean(
              item && typeof item === 'object' && typeof (item as { id?: unknown }).id === 'string'
            )
        )
      : (entry.queued ?? []).map((item) => ({ id: item.id, text: item.text }));
    const goal =
      entry.goal ??
      (persisted?.goal && typeof persisted.goal === 'object'
        ? (persisted.goal as HeadlessSessionRuntime['goal'])
        : undefined);
    runtimes.set(entry.id, {
      status: entry.status,
      started: agent?.isAlive(entry.id) === true || entry.status === 'running',
      queued,
      goal,
      pendingApprovals: entry.pendingApprovalCount ?? 0,
      pendingAsks: entry.pendingAskCount ?? 0,
      compaction: false,
      abortRequested: false,
    });
  }
}

function persistedForResume(sessionId: string): PersistedPairConversation | null {
  const row = readPersistedConversation(sessionId);
  if (!row) return null;
  const projectId = typeof row.projectId === 'string' ? row.projectId : '';
  if (!projectId) return null;
  return {
    sessionId,
    projectId,
    ...(typeof row.sessionFile === 'string' ? { sessionFile: row.sessionFile } : {}),
    ...(typeof row.lastProviderId === 'string' ? { lastProviderId: row.lastProviderId } : {}),
    ...(typeof row.lastModelId === 'string' ? { lastModelId: row.lastModelId } : {}),
    ...(typeof row.reasoningEnabled === 'boolean'
      ? { reasoningEnabled: row.reasoningEnabled }
      : {}),
    ...(typeof row.thinkingLevel === 'string' ? { thinkingLevel: row.thinkingLevel } : {}),
    ...(typeof row.presetId === 'string' ? { presetId: row.presetId } : {}),
    ...(typeof row.approvalMode === 'string' ? { approvalMode: row.approvalMode } : {}),
  };
}

export async function resumePairSessionHeadless(sessionId: string): Promise<void> {
  if (!agent) return;
  const conversation = persistedForResume(sessionId);
  const plan = planPairResume({
    alive: agent.isAlive(sessionId),
    conversation,
    projectPath: conversation ? agent.projectPath(conversation.projectId) : undefined,
    worktreePath: agent.worktreePath(sessionId),
    worktreeMissing: agent.worktreeMissing(sessionId),
    loadLocalSkills: agent.loadLocalSkills(),
  });
  if (plan.type === 'snapshot') {
    agent.requestSnapshot(sessionId);
    const runtime = runtimeOf(sessionId);
    setRuntime(sessionId, { ...runtime, started: true });
    return;
  }
  if (plan.type === 'skip') return;
  const result = await agent.spawn(plan.request);
  if (result.ok) {
    const runtime = runtimeOf(sessionId);
    setRuntime(sessionId, { ...runtime, started: true, status: 'idle' });
  }
}

export function adoptPairSessionHeadless(session: PairCreatedSession): void {
  const createdAt = Date.now();
  patchConversationsState((state) => {
    if (state.conversations[session.sessionId]) return;
    state.conversations[session.sessionId] = {
      id: session.sessionId,
      projectId: session.projectId,
      title: '',
      createdAt,
      lastActiveAt: createdAt,
      messages: [],
      commands: [],
      customEntries: [],
      dispatchMainEvents: {},
      lastSeq: 0,
      spawning: false,
      status: 'idle',
      started: false,
      reasoningEnabled: session.reasoningEnabled,
      thinkingLevel: session.thinkingLevel ?? 'medium',
      lastProviderId: session.providerId,
      lastModelId: session.modelId,
      ...(session.presetId ? { presetId: session.presetId } : {}),
      ...(session.approvalMode ? { approvalMode: session.approvalMode } : {}),
    };
    state.order = [session.sessionId, ...state.order.filter((id) => id !== session.sessionId)];
  });
  agent?.createAuthority(session.sessionId, session.projectId);
  const projectName =
    getPairProjects().find((project) => project.id === session.projectId)?.name ?? '';
  mutatePairCatalog(
    (catalog) =>
      upsertCatalogEntry(
        catalog,
        catalogEntryFromPairSession(session, projectName)
      ) as CatalogEntry[]
  );
  setRuntime(session.sessionId, {
    ...emptyHeadlessRuntime(),
    started: true,
    status: 'idle',
  });
}

export function applyPairSessionConfigHeadless(config: PairSessionConfig): void {
  const sessionId = config.sessionId;
  const runtime = runtimeOf(sessionId);
  if (config.type === 'set-model') {
    patchConversationsState((state) => {
      const current = state.conversations[sessionId];
      if (!current) return;
      state.conversations[sessionId] = {
        ...current,
        lastProviderId: config.providerId,
        lastModelId: config.modelId,
      };
    });
    pushCatalog(sessionId, runtime, { providerId: config.providerId, modelId: config.modelId });
    if (runtime.started) agent?.setModel(sessionId, config.providerId, config.modelId);
    return;
  }
  if (config.type === 'set-reasoning') {
    patchConversationsState((state) => {
      const current = state.conversations[sessionId];
      if (!current) return;
      state.conversations[sessionId] = { ...current, reasoningEnabled: config.enabled };
    });
    pushCatalog(sessionId, runtime, { reasoningEnabled: config.enabled });
    if (runtime.started) {
      const level = readPersistedConversation(sessionId)?.thinkingLevel;
      agent?.setReasoning(sessionId, config.enabled, typeof level === 'string' ? level : undefined);
    }
    return;
  }
  patchConversationsState((state) => {
    const current = state.conversations[sessionId];
    if (!current) return;
    state.conversations[sessionId] = { ...current, thinkingLevel: config.level };
  });
  pushCatalog(sessionId, runtime, { thinkingLevel: config.level });
  if (runtime.started) agent?.setThinking(sessionId, config.level);
}

export function applyPairQueueActionHeadless(action: PairQueueAction): void {
  const sessionId = action.sessionId;
  if (action.type === 'compact') {
    agent?.compact(sessionId, action.instructions);
    return;
  }
  if (action.type === 'rewind') {
    agent?.rewind(sessionId, action.userIndexFromEnd, action.restoreFiles);
    return;
  }
  if (action.type === 'retry') {
    agent?.retry(sessionId);
    return;
  }
  if (action.type === 'task-stop') {
    agent?.stopTask(sessionId, action.taskId);
    return;
  }
  if (action.type === 'subagent-stop') {
    agent?.stopSubagent(sessionId, action.agentId);
    return;
  }
  const applied = applyHeadlessQueueAction(runtimeOf(sessionId), action, randomUUID);
  setRuntime(sessionId, applied.runtime);
  persistRuntime(sessionId, applied.runtime);
  pushCatalog(sessionId, applied.runtime);
  if (applied.abort) {
    pendingInterrupt.set(sessionId, action.type === 'queue-interrupt-send' ? action.messageId : '');
    agent?.abort(sessionId);
    return;
  }
  if (applied.deliver) deliver(sessionId, applied.deliver);
}

export function handlePairHeadlessAgentEvent(event: RendererAgentEvent): void {
  if (!headless) return;
  if (event.type === 'title-generated' || event.type === 'title-failed') {
    settleTitle(event.conversationId, event.type === 'title-generated' ? event.title : '');
    return;
  }
  const sessionId =
    'identity' in event && event.identity && 'sessionId' in event.identity
      ? event.identity.sessionId
      : 'sessionId' in event
        ? event.sessionId
        : undefined;
  if (typeof sessionId !== 'string' || !sessionId) return;
  const runtime = runtimeOf(sessionId);
  touchBeat(sessionId, event, runtime.status);
  if (event.type === 'message-upsert' && event.message.role === 'user') {
    titleFromFirstMessage(sessionId, event.message.content);
  }
  if (event.type === 'approval-request') {
    setRuntime(sessionId, { ...runtime, pendingApprovals: runtime.pendingApprovals + 1 });
    return;
  }
  if (event.type === 'ask-request') {
    setRuntime(sessionId, { ...runtime, pendingAsks: runtime.pendingAsks + 1 });
    return;
  }
  if (event.type === 'status') {
    const status = event.status;
    if (status === 'running') {
      const next = { ...runtime, started: true, status };
      setRuntime(sessionId, next);
      pushCatalog(sessionId, next);
      return;
    }
    if (status === 'idle' || status === 'failed') {
      finishTurn(sessionId, { ...runtime, started: true, status });
    }
    return;
  }
  if (event.type === 'turn-completed' || event.type === 'turn-failed') {
    finishTurn(sessionId, { ...runtime, started: true, pendingApprovals: 0, pendingAsks: 0 });
  }
}

function finishTurn(sessionId: string, runtime: HeadlessSessionRuntime): void {
  const interruptId = pendingInterrupt.get(sessionId);
  const idle = onHeadlessIdle(runtime);
  let next = idle.runtime;
  let delivery = idle.deliver;
  if (interruptId) {
    pendingInterrupt.delete(sessionId);
    const sent = applyHeadlessQueueAction(
      next,
      { type: 'queue-send-now', sessionId, messageId: interruptId },
      randomUUID
    );
    next = sent.runtime;
    delivery = sent.deliver;
  }
  setRuntime(sessionId, next);
  persistRuntime(sessionId, next);
  pushCatalog(sessionId, next);
  if (delivery) deliver(sessionId, delivery);
}

function touchBeat(sessionId: string, event: RendererAgentEvent, status: string): void {
  const beat = beats.get(sessionId) ?? { at: 0, attempts: 0, pendingRetry: false };
  beat.at = Date.now();
  if (event.type === 'tool-output' && typeof event.deadlineAt === 'number') {
    beat.deadline = Math.max(beat.deadline ?? 0, event.deadlineAt);
  }
  if (event.type === 'turn-completed' || event.type === 'turn-failed') beat.deadline = undefined;
  if (status === 'running' && event.type !== 'status' && !beat.pendingRetry) beat.attempts = 0;
  beats.set(sessionId, beat);
}

function heartbeatAt(sessionId: string): number | undefined {
  const own = beats.get(sessionId);
  let at = own ? Math.max(own.at, own.deadline ?? 0) : undefined;
  const coworkerIds = readPersistedConversation(sessionId)?.coworkerIds;
  if (!Array.isArray(coworkerIds)) return at;
  for (const id of coworkerIds) {
    if (typeof id !== 'string' || runtimes.get(id)?.status !== 'running') continue;
    const child = beats.get(id);
    const childAt = child ? Math.max(child.at, child.deadline ?? 0) : undefined;
    if (childAt !== undefined && (at === undefined || childAt > at)) at = childAt;
  }
  return at;
}

function stallTick(): void {
  const timeoutMs = agent?.stallTimeoutMs() ?? 0;
  if (!agent || timeoutMs <= 0) return;
  const now = Date.now();
  for (const [sessionId, runtime] of runtimes) {
    const beat = beats.get(sessionId) ?? { at: now, attempts: 0, pendingRetry: false };
    beats.set(sessionId, beat);
    if (beat.pendingRetry && runtime.status === 'running') continue;
    const action = nextStallWatchAction({
      shouldAbort: shouldAbortStalledGeneration({
        status: runtime.status,
        lastOutputAt: heartbeatAt(sessionId),
        now,
        timeoutMs,
        hasLiveWork: hasLiveGenerationWork({
          pendingApprovals: runtime.pendingApprovals,
          pendingAsks: runtime.pendingAsks,
        }),
      }),
      status: runtime.status,
      pendingRetry: beat.pendingRetry,
      attempts: beat.attempts,
    });
    if (action === 'abort') {
      beat.pendingRetry = true;
      agent.abort(sessionId);
    } else if (action === 'retry') {
      beat.pendingRetry = false;
      beat.attempts += 1;
      agent.retry(sessionId);
    } else if (action === 'give-up') {
      beat.pendingRetry = false;
      beat.attempts = 0;
      console.warn(`[pair] ${sessionId}: stopped after repeated stalls`);
    }
  }
}

function writeTitle(sessionId: string, title: string): void {
  patchConversationsState((state) => {
    const current = state.conversations[sessionId];
    if (current) state.conversations[sessionId] = { ...current, title };
  });
  pushCatalog(sessionId, runtimeOf(sessionId), { title });
}

/** 手机建的冷会话没有标题：取首条用户消息代表行，再请求模型总结（与 leader 渲染器同口径） */
function titleFromFirstMessage(sessionId: string, content: ReadonlyArray<unknown>): void {
  const row = readPersistedConversation(sessionId);
  if (!row || row.titleLocked === true || (typeof row.title === 'string' && row.title.trim())) {
    return;
  }
  const raw = splitPlanPrefix(
    splitUnattendedPrefix(
      content
        .flatMap((part) =>
          part && typeof part === 'object' && (part as { type?: unknown }).type === 'text'
            ? [String((part as { text?: unknown }).text ?? '')]
            : []
        )
        .join(' ')
        .trim()
    ).rest
  ).rest;
  if (!raw) return;
  const title = extractRepresentativeTitle(raw);
  writeTitle(sessionId, title);
  const source = cleanTitleSummarySource(raw);
  if (!agent || !source.trim()) return;
  titleBaselines.set(sessionId, title);
  const model =
    typeof row.lastProviderId === 'string' && typeof row.lastModelId === 'string'
      ? { providerId: row.lastProviderId, modelId: row.lastModelId }
      : undefined;
  void agent
    .summarizeTitle(sessionId, { kind: 'initial', text: source }, model)
    .then((result) => {
      if (!result.ok) titleBaselines.delete(sessionId);
    })
    .catch(() => titleBaselines.delete(sessionId));
}

function settleTitle(sessionId: string, generated: string): void {
  const baseline = titleBaselines.get(sessionId);
  if (baseline === undefined) return;
  titleBaselines.delete(sessionId);
  const title = generated.trim().slice(0, 80);
  const row = readPersistedConversation(sessionId);
  if (!title || !row || row.titleLocked === true || row.title !== baseline) return;
  if (title !== baseline) writeTitle(sessionId, title);
}
