import { randomUUID } from 'node:crypto';
import { readFileSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import {
  type AgentTypeKey,
  type AgentTypeRegistrySnapshot,
  type ChildSessionIdentity,
  ENSO_LOCKED_PROFILE_ID,
  isSameChildSessionIdentity,
  type SessionIdentity,
} from '@shared/builtinAgents';
import type {
  CapabilityInvocationContext,
  CapabilityReceipt,
  ReceiptLifecycleEvent,
} from '@shared/capabilities/types';
import {
  type AgentSessionCustomEntry,
  type AgentSpawnRequest,
  type AgentWorkerEvent,
  type ChildLifecycleEvent,
  type DispatchMainEvent,
  type DispatchProgressPhase,
  type DispatchTerminal,
  type ModelRef,
  type ParentLifecycleEvent,
  parseChildConversationMetadata,
  type RendererAgentEvent,
  type ResolvedAgentTypeSpawnConfig,
  type SpawnModelConfig,
} from '@shared/types/agent';
import type {
  AgentDispatchRequest,
  AgentDispatchResult,
  AgentDispatchTask,
} from '@shared/types/mentions';
import type { ActiveConversationRegistry, ParentSourceBinding } from './activeConversationRegistry';
import type { AgentSessionIndex, ChildReservation, TeamOperationResult } from './agentSessionIndex';

interface ModelSelection {
  ref: ModelRef;
  runtimeRef: ModelRef;
  config: SpawnModelConfig;
}

interface ModelResolution {
  ok: boolean;
  selection?: ModelSelection;
  error?: string;
}

interface AgentTypeResolution {
  ok: boolean;
  config?: ResolvedAgentTypeSpawnConfig;
  expectedModel?: ModelRef;
  expectedToolIds?: readonly string[];
  error?: string;
}

interface DispatchHost {
  registrySnapshot(): AgentTypeRegistrySnapshot;
  resolveModel(
    providerId: string,
    modelId: string,
    authenticatedAccountKeys: ReadonlySet<string>
  ): ModelResolution;
  resolveAgentType(
    typeKey: AgentTypeKey,
    parentModel: ModelSelection,
    authenticatedAccountKeys: ReadonlySet<string>
  ): AgentTypeResolution;
  spawnParent(
    identity: SessionIdentity,
    request: AgentSpawnRequest,
    authenticatedAccountKeys: ReadonlySet<string>
  ): { ok: boolean; error?: string };
  spawnChild(
    identity: ChildSessionIdentity,
    cwd: string,
    config: ResolvedAgentTypeSpawnConfig,
    resumeFile?: string
  ): { ok: boolean; error?: string };
  promptChild(
    identity: ChildSessionIdentity,
    requestId: string,
    task: AgentDispatchTask
  ): { ok: boolean; error?: string };
  appendCustomEntry(
    identity: SessionIdentity,
    entry: AgentSessionCustomEntry
  ): { ok: boolean; error?: string };
  dismissChild(
    parent: SessionIdentity,
    child: ChildSessionIdentity,
    notify?: boolean
  ): { ok: boolean; error?: string };
  /** 重启后恢复 worker 直雇 coworker（双形状过渡；参数全部来自 Main 自读的持久化） */
  resumeCoworker(
    parent: SessionIdentity,
    coworkerId: string,
    name: string,
    agentType: string | undefined,
    resumeFile: string
  ): { ok: boolean; error?: string };
}

export interface TeamExecutionGuard {
  signal: AbortSignal;
  assertExecutionCurrent(): boolean;
}

export interface AgentDispatchServiceOptions {
  sourceRegistry: ActiveConversationRegistry;
  sessionIndex: AgentSessionIndex;
  host: DispatchHost;
  readStoredOauthCredentialKeys: () => Promise<ReadonlySet<string>>;
  emitRendererEvent: (event: RendererAgentEvent) => void;
  emitDispatchEvent?: (ownerWebContentsId: number, event: DispatchMainEvent) => void;
  registerCapabilityInvocation?: (context: CapabilityInvocationContext) => boolean;
  terminateGeneration?: (child: ChildSessionIdentity) => void;
  randomUuid?: () => string;
  now?: () => number;
  readyTimeoutMs?: number;
}

interface EventWaiter {
  accept(event: AgentWorkerEvent | { type: 'worker-exited' }): boolean;
  timer: NodeJS.Timeout;
}

interface ActiveDispatch {
  dispatchId: string;
  requestId: string;
  ownerWebContentsId: number;
  turnId: string;
  child: ChildSessionIdentity;
  parent: SessionIdentity;
  seq: number;
  pendingReceiptIds: Set<string>;
  receipts: CapabilityReceipt[];
  turnTerminal?: DispatchTerminal;
  terminal?: DispatchTerminal;
}

const MAX_RECENT_DISPATCHES = 128;
const MAX_FILE_MENTION_BYTES = 256 * 1024;

function isSameGeneration(left: SessionIdentity, right: SessionIdentity): boolean {
  return left.sessionId === right.sessionId && left.generation === right.generation;
}
const MAX_FILE_MENTION_TOTAL_BYTES = 512 * 1024;

export class AgentDispatchService {
  private readonly waiters = new Set<EventWaiter>();
  private readonly active = new Map<string, ActiveDispatch>();
  private readonly recent = new Map<string, AgentDispatchResult>();
  private readonly inFlight = new Map<string, Promise<AgentDispatchResult>>();
  private readonly parentReady = new Map<string, Promise<void>>();
  private readonly prompted = new Set<string>();
  private readonly teamGuards = new Map<string, TeamExecutionGuard>();
  /** 已级联恢复过的父代（sessionId\0generation）：parent-ready 重放不重复 spawn */
  private readonly restoredParents = new Set<string>();
  private readonly randomUuid: () => string;
  private readonly now: () => number;
  private readonly readyTimeoutMs: number;

  constructor(private readonly options: AgentDispatchServiceOptions) {
    this.randomUuid = options.randomUuid ?? randomUUID;
    this.now = options.now ?? Date.now;
    this.readyTimeoutMs = options.readyTimeoutMs ?? 10_000;
  }

  async dispatch(
    request: AgentDispatchRequest,
    ownerWebContentsId: number
  ): Promise<AgentDispatchResult> {
    const dispatchKey = `${ownerWebContentsId}\u0000${request.requestId}`;
    const completed = this.recent.get(dispatchKey);
    if (completed) return completed;
    const running = this.inFlight.get(dispatchKey);
    if (running) return running;
    const operation = this.executeDispatch(request, ownerWebContentsId).then((result) => {
      this.inFlight.delete(dispatchKey);
      this.remember(dispatchKey, result);
      return result;
    });
    this.inFlight.set(dispatchKey, operation);
    return operation;
  }

  async hireCoworker(
    parentConversationId: string,
    name: string,
    agentType?: string,
    guard?: TeamExecutionGuard
  ): Promise<TeamOperationResult> {
    if (!this.guardCurrent(guard)) return this.cancelledTeamOperation();
    const target = this.options.sessionIndex.resolveTeamTarget(parentConversationId);
    if (!target.ok) return target;
    const source = this.options.sourceRegistry.resolveParentSource(parentConversationId);
    if (!source) {
      return {
        ok: false,
        code: 'unavailable',
        error: 'The parent source is unavailable.',
        suggestedAction: 'Open or resume the coding conversation, then retry.',
      };
    }
    let credentialKeys: ReadonlySet<string>;
    try {
      credentialKeys = await this.options.readStoredOauthCredentialKeys();
    } catch {
      return {
        ok: false,
        code: 'unavailable',
        error: 'Model credentials could not be verified.',
        suggestedAction: 'Check the model login and retry.',
      };
    }
    const parentModel = this.options.host.resolveModel(
      source.selectedModel.providerId,
      source.selectedModel.modelId,
      credentialKeys
    );
    if (!parentModel.ok || !parentModel.selection) {
      return {
        ok: false,
        code: 'unavailable',
        error: parentModel.error ?? 'The parent model is unavailable.',
        suggestedAction: 'Select a usable model and retry.',
      };
    }
    const snapshot = this.options.host.registrySnapshot();
    const normalized = agentType?.trim().toLocaleLowerCase('en-US');
    const candidate =
      snapshot.candidates.find(
        (entry) =>
          entry.typeKey === agentType || entry.displayName.toLocaleLowerCase('en-US') === normalized
      ) ??
      (!agentType
        ? snapshot.candidates.find((entry) => entry.typeKey === 'builtin:worker')
        : undefined);
    if (!candidate) {
      return {
        ok: false,
        code: 'unavailable',
        error: `Agent type is unavailable: ${agentType ?? 'worker'}`,
        suggestedAction: 'Choose an available Agent type.',
      };
    }
    const resolved = this.options.host.resolveAgentType(
      candidate.typeKey,
      parentModel.selection,
      credentialKeys
    );
    if (!resolved.ok || !resolved.config || !resolved.expectedModel) {
      return {
        ok: false,
        code: 'unavailable',
        error: resolved.error ?? 'The Agent type is unavailable.',
        suggestedAction: 'Choose an available Agent type and model.',
      };
    }
    if (!this.guardCurrent(guard)) return this.cancelledTeamOperation();
    const reserved = this.options.sessionIndex.reserveChild(
      target.identity,
      candidate.typeKey,
      name,
      `team-${this.randomUuid()}`,
      candidate.typeKey === 'agent:enso' ? ENSO_LOCKED_PROFILE_ID : undefined
    );
    if (!reserved.ok) {
      return {
        ok: false,
        code: 'unavailable',
        error: reserved.error,
        suggestedAction:
          reserved.code === 'capacity-reached'
            ? 'Dismiss one coworker before hiring another.'
            : 'Retry from the current parent generation.',
      };
    }
    const child = reserved.reservation.child;
    if (!this.guardCurrent(guard)) {
      this.options.sessionIndex.releaseChild(child);
      return this.cancelledTeamOperation();
    }
    this.options.emitRendererEvent({
      type: 'child-reserved',
      identity: child,
      seq: 0,
      requestId: reserved.reservation.requestId,
      metadata: reserved.reservation.metadata,
    });
    try {
      if (guard) this.teamGuards.set(child.generation, guard);
      const spawned = this.options.host.spawnChild(
        child,
        source.parentProjectPath,
        resolved.config
      );
      if (!spawned.ok) throw new Error(spawned.error ?? 'Failed to spawn coworker.');
      const ready = await this.waitForChild(child, guard?.signal);
      this.verifyChildReady(
        reserved.reservation,
        ready,
        resolved.config,
        resolved.expectedModel,
        resolved.expectedToolIds ?? []
      );
      const listed = this.options.sessionIndex.listCoworkers(parentConversationId);
      const coworker = listed.ok ? listed.data.find((entry) => entry.id === child.sessionId) : null;
      if (!coworker) throw new Error('Coworker ready state was not indexed.');
      return { ok: true, data: { conversationId: parentConversationId, coworker } };
    } catch (error) {
      this.options.sessionIndex.releaseChild(child);
      this.options.host.dismissChild(target.identity, child, false);
      return {
        ok: false,
        code: 'unavailable',
        error: error instanceof Error ? error.message : String(error),
        suggestedAction: 'Retry from the current coding conversation.',
      };
    } finally {
      this.teamGuards.delete(child.generation);
    }
  }

  async dismissCoworker(
    parentConversationId: string,
    coworkerId: string,
    guard?: TeamExecutionGuard
  ): Promise<TeamOperationResult> {
    if (!this.guardCurrent(guard)) return this.cancelledTeamOperation();
    const target = this.options.sessionIndex.resolveTeamTarget(parentConversationId);
    if (!target.ok) return target;
    const existing = target.coworkers.get(coworkerId);
    const child = this.options.sessionIndex.currentIdentity(coworkerId);
    if (
      !existing ||
      !child ||
      !('parent' in child) ||
      !isSameGeneration(child.parent, target.identity)
    ) {
      return {
        ok: false,
        code: 'unavailable',
        error: 'Coworker is not active in the current parent generation.',
        suggestedAction: 'List coworkers and choose an active id.',
      };
    }
    if (!this.guardCurrent(guard)) return this.cancelledTeamOperation();
    const sent = this.options.host.dismissChild(target.identity, child, false);
    if (!sent.ok) {
      return {
        ok: false,
        code: 'unavailable',
        error: sent.error ?? 'Failed to dismiss coworker.',
        suggestedAction: 'Retry from the current coding conversation.',
      };
    }
    try {
      await this.waitFor(
        (event): event is Extract<ChildLifecycleEvent, { type: 'child-ended' }> =>
          event.type === 'child-ended' && isSameChildSessionIdentity(child, event.identity),
        () => false
      );
      return {
        ok: true,
        data: {
          conversationId: parentConversationId,
          coworker: { ...existing, status: 'dismissed' },
        },
      };
    } catch (error) {
      return {
        ok: false,
        code: 'unavailable',
        error: error instanceof Error ? error.message : String(error),
        suggestedAction: 'Retry or inspect the coworker status.',
      };
    }
  }

  observe(event: AgentWorkerEvent | { type: 'worker-exited' }): void {
    const readyGuard =
      event.type === 'child-ready' ? this.teamGuards.get(event.identity.generation) : undefined;
    if (!readyGuard || this.guardCurrent(readyGuard)) {
      this.options.sessionIndex.observe(event);
    }
    // 级联恢复在 sessionIndex.observe 之后：resolveParentSource 要读 ready 后的 parent 模型
    if (event.type === 'parent-ready') {
      void this.restoreChildren(event.identity).catch(() => {
        // 恢复是尽力而为：单个失败不影响父会话可用性，残局 tab 可关、历史可回放
      });
    }
    for (const waiter of [...this.waiters]) {
      if (waiter.accept(event)) {
        clearTimeout(waiter.timer);
        this.waiters.delete(waiter);
      }
    }
    if (event.type === 'worker-exited') {
      for (const dispatch of this.active.values()) {
        dispatch.turnTerminal = 'cancelled';
        this.trySettle(dispatch);
        this.options.terminateGeneration?.(dispatch.child);
      }
      return;
    }
    if (event.type === 'snapshot') return;
    if (event.type === 'child-rejected' || event.type === 'child-ended') {
      const dispatch = this.active.get(event.identity.generation);
      if (dispatch) {
        dispatch.turnTerminal = event.type === 'child-ended' ? 'cancelled' : 'failed';
        this.trySettle(dispatch);
      }
      this.options.terminateGeneration?.(event.identity);
      return;
    }
    if (event.type !== 'turn-completed' && event.type !== 'turn-failed') return;
    const dispatch = this.active.get(event.identity.generation);
    if (
      !dispatch ||
      dispatch.turnId !== event.turnId ||
      !isSameGeneration(dispatch.child, event.identity)
    ) {
      return;
    }
    dispatch.turnTerminal = event.type === 'turn-completed' ? 'completed' : 'failed';
    this.trySettle(dispatch);
  }

  observeReceipt(event: ReceiptLifecycleEvent): void {
    const dispatch = this.active.get(event.child.generation);
    // 关联键只能是 child 身份 + turnId：event.requestId 是每笔能力调用自己的 uuid
    // （见 agent/tools/ensoApp.ts），与派发请求 id 不同命名空间；拿它与 dispatch.requestId
    // 相比永远不相等，会把全部 receipt 丢掉，导致父会话完成通知拿不到安全 summary。
    if (
      !dispatch ||
      dispatch.turnId !== event.turnId ||
      !isSameChildSessionIdentity(dispatch.child, event.child) ||
      dispatch.terminal
    ) {
      return;
    }
    if (event.type === 'receipt-started') {
      if (!dispatch.receipts.some((receipt) => receipt.receiptId === event.receiptId)) {
        dispatch.pendingReceiptIds.add(event.receiptId);
      }
      return;
    }
    dispatch.pendingReceiptIds.delete(event.receiptId);
    if (!dispatch.receipts.some((receipt) => receipt.receiptId === event.receiptId)) {
      dispatch.receipts.push(event.receipt);
    }
    this.trySettle(dispatch);
  }

  private trySettle(dispatch: ActiveDispatch): void {
    if (dispatch.terminal || !dispatch.turnTerminal || dispatch.pendingReceiptIds.size > 0) return;
    const failedReceipt = dispatch.receipts.some((receipt) =>
      ['denied', 'failed', 'unavailable'].includes(receipt.outcome)
    );
    const successfulCommit = dispatch.receipts.some((receipt) => receipt.outcome === 'succeeded');
    const terminal: DispatchTerminal =
      dispatch.turnTerminal === 'completed' && !failedReceipt
        ? 'completed'
        : dispatch.turnTerminal === 'cancelled' && !successfulCommit
          ? 'cancelled'
          : 'failed';
    dispatch.terminal = terminal;
    const receiptSummary = dispatch.receipts
      .map((receipt) => receipt.summary)
      .join('; ')
      .slice(0, 600);
    const childRef = {
      sessionId: dispatch.child.sessionId,
      generation: dispatch.child.generation,
      instanceId: dispatch.child.instanceId,
      instanceName: dispatch.child.instanceName,
      typeKey: dispatch.child.typeKey,
    };
    const entry: AgentSessionCustomEntry =
      terminal === 'completed'
        ? {
            kind: 'agent-completed',
            child: childRef,
            ...(receiptSummary ? { receiptSummary } : {}),
            at: this.now(),
          }
        : {
            kind: 'agent-failed',
            child: childRef,
            errorCode: terminal === 'cancelled' ? 'child-cancelled' : 'child-failed',
            message:
              receiptSummary || (terminal === 'cancelled' ? 'Agent cancelled.' : 'Agent failed.'),
            at: this.now(),
          };
    this.options.host.appendCustomEntry(dispatch.parent, entry);
    this.emitDispatch(dispatch, {
      phase: 'terminal',
      terminal,
      ...(receiptSummary ? { receiptSummary } : {}),
    });
    this.options.terminateGeneration?.(dispatch.child);
    this.active.delete(dispatch.child.generation);
    this.prompted.delete(`${dispatch.child.generation}\u0000${dispatch.requestId}`);
  }

  private async executeDispatch(
    request: AgentDispatchRequest,
    ownerWebContentsId: number
  ): Promise<AgentDispatchResult> {
    const binding = this.options.sourceRegistry.consumeSelection(
      request.selectionBindingId,
      ownerWebContentsId
    );
    if (!binding) {
      return this.rejected(
        request,
        'invalid-binding',
        'The conversation binding expired. Retry.',
        'retry'
      );
    }
    const candidate = this.options.host
      .registrySnapshot()
      .candidates.find((entry) => entry.typeKey === request.typeKey);
    if (!candidate) {
      return this.rejected(
        request,
        'unknown-agent-type',
        'The selected Agent type is no longer available.',
        'open-agent-types'
      );
    }

    let credentialKeys: ReadonlySet<string>;
    try {
      credentialKeys = await this.options.readStoredOauthCredentialKeys();
    } catch {
      return this.rejected(
        request,
        'parent-model-unavailable',
        'Model credentials could not be verified.',
        'select-model'
      );
    }
    const parentModel = this.options.host.resolveModel(
      binding.selectedModel.providerId,
      binding.selectedModel.modelId,
      credentialKeys
    );
    if (!parentModel.ok || !parentModel.selection) {
      return this.rejected(
        request,
        'parent-model-unavailable',
        parentModel.error ?? 'The parent model is unavailable.',
        'select-model'
      );
    }
    const agentType = this.options.host.resolveAgentType(
      request.typeKey,
      parentModel.selection,
      credentialKeys
    );
    if (!agentType.ok || !agentType.config || !agentType.expectedModel) {
      return this.rejected(
        request,
        'unknown-agent-type',
        agentType.error ?? 'The Agent type is unavailable.',
        'open-agent-types'
      );
    }

    const parent = this.currentOrNewParent(binding);
    const profileId = request.typeKey === 'agent:enso' ? ENSO_LOCKED_PROFILE_ID : undefined;
    const reserved = this.options.sessionIndex.reserveChild(
      parent,
      request.typeKey,
      candidate.displayName,
      request.requestId,
      profileId
    );
    if (!reserved.ok) {
      return this.rejected(
        request,
        reserved.code === 'capacity-reached' ? 'capacity-reached' : 'dispatch-failed',
        reserved.error,
        reserved.code === 'capacity-reached' ? undefined : 'retry'
      );
    }

    const reservation = reserved.reservation;
    const dispatch: ActiveDispatch = {
      dispatchId: this.randomUuid(),
      requestId: request.requestId,
      ownerWebContentsId,
      turnId: request.requestId,
      child: reservation.child,
      parent,
      seq: 0,
      pendingReceiptIds: new Set(),
      receipts: [],
    };
    this.active.set(reservation.child.generation, dispatch);
    this.emitDispatch(dispatch, { phase: 'capacity-reserved' });
    this.options.emitRendererEvent({
      type: 'child-reserved',
      identity: reservation.child,
      seq: 0,
      requestId: request.requestId,
      metadata: reservation.metadata,
    });

    try {
      this.emitDispatch(dispatch, { phase: 'parent-spawning' });
      await this.ensureParentReady(binding, parent, parentModel.selection, credentialKeys);
      this.emitDispatch(dispatch, { phase: 'parent-ready' });
      const task = this.snapshotFileMentions(binding.parentProjectPath, request.task);
      this.emitDispatch(dispatch, { phase: 'child-spawning' });
      const spawned = this.options.host.spawnChild(
        reservation.child,
        binding.parentProjectPath,
        agentType.config
      );
      if (!spawned.ok) throw new Error(spawned.error ?? 'Failed to spawn child Agent.');
      const ready = await this.waitForChild(reservation.child);
      this.verifyChildReady(
        reservation,
        ready,
        agentType.config,
        agentType.expectedModel,
        agentType.expectedToolIds ?? []
      );
      this.emitDispatch(dispatch, { phase: 'child-ready' });
      if (
        reservation.child.typeKey === 'agent:enso' &&
        this.options.registerCapabilityInvocation &&
        !this.options.registerCapabilityInvocation({
          child: reservation.child,
          parentBinding: {
            parentConversationId: binding.parentConversationId,
            parentProjectId: binding.parentProjectId,
            parentProjectPath: binding.parentProjectPath,
          },
          turnId: request.requestId,
          ownerWebContentsId,
        })
      ) {
        throw new Error('Failed to bind the Enso capability generation.');
      }
      const promptKey = `${reservation.child.generation}\u0000${request.requestId}`;
      if (!this.prompted.has(promptKey)) {
        const prompted = this.options.host.promptChild(reservation.child, request.requestId, task);
        if (!prompted.ok) throw new Error(prompted.error ?? 'Failed to prompt child Agent.');
        this.prompted.add(promptKey);
      }
      this.emitDispatch(dispatch, { phase: 'task-dispatched' });
      this.emitDispatch(dispatch, { phase: 'running' });
      const childRef = {
        sessionId: reservation.child.sessionId,
        generation: reservation.child.generation,
        instanceId: reservation.child.instanceId,
        instanceName: reservation.child.instanceName,
        typeKey: reservation.child.typeKey,
      };
      const appended = this.options.host.appendCustomEntry(parent, {
        kind: 'agent-dispatch',
        child: childRef,
        at: this.now(),
      });
      if (!appended.ok) throw new Error(appended.error ?? 'Failed to record dispatch.');
      return {
        accepted: true,
        dispatchId: dispatch.dispatchId,
        requestId: request.requestId,
        child: reservation.child,
      };
    } catch (error) {
      this.options.sessionIndex.releaseChild(reservation.child);
      this.options.terminateGeneration?.(reservation.child);
      this.options.host.dismissChild(parent, reservation.child, false);
      dispatch.turnTerminal = 'failed';
      this.trySettle(dispatch);
      const reason = error instanceof Error ? error.message : String(error);
      this.options.emitRendererEvent({
        type: 'child-rejected',
        identity: reservation.child,
        seq: 0,
        reason,
      });
      return this.rejected(request, 'dispatch-failed', reason, 'retry');
    }
  }

  /**
   * 父会话 ready 后按 Main 自读的持久化级联恢复 child（08-28 design §7.3）。
   * 尽力而为：单个 child 失败只跳过（渲染层落只读回放/可关闭的残局 tab）；
   * 幂等键是 parent generation，派发链路重放的 parent-ready 不重复 spawn。
   * 渲染层全程不参与：sessionFile/类型/名字都从 settings 持久化取。
   */
  private async restoreChildren(parent: SessionIdentity): Promise<void> {
    const key = `${parent.sessionId}\u0000${parent.generation}`;
    if (this.restoredParents.has(key)) return;
    this.restoredParents.add(key);
    const persisted = this.options.sessionIndex.persistedConversation(parent.sessionId);
    const coworkerIds = Array.isArray(persisted?.coworkerIds)
      ? persisted.coworkerIds.filter((id): id is string => typeof id === 'string')
      : [];
    if (coworkerIds.length === 0) return;
    const source = this.options.sourceRegistry.resolveParentSource(parent.sessionId);
    if (!source) return;
    const credentialKeys = await this.options.readStoredOauthCredentialKeys();
    for (const coworkerId of coworkerIds) {
      const child = this.options.sessionIndex.persistedConversation(coworkerId);
      if (!child || child.ended === true) continue;
      const resumeFile = typeof child.sessionFile === 'string' ? child.sessionFile : undefined;
      if (!resumeFile) continue;
      // 已活着的跳过（刷新/重建窗口时 worker 侧会话仍在）
      const existing = this.options.sessionIndex.currentIdentity(coworkerId);
      if (existing && this.options.sessionIndex.isReady(existing)) continue;
      const metadata = parseChildConversationMetadata(child.child);
      if (metadata) {
        // typed child：registry 重新解析，类型已删/禁用 → 不恢复不降级（只读回放兑底）；
        // 模型继承恢复后的 parent 模型（resolveParentSource 读 sessionIndex.model）
        const model = this.options.host.resolveModel(
          source.selectedModel.providerId,
          source.selectedModel.modelId,
          credentialKeys
        );
        if (!model.ok || !model.selection) continue;
        const resolved = this.options.host.resolveAgentType(
          metadata.agentTypeKey,
          model.selection,
          credentialKeys
        );
        if (!resolved.ok || !resolved.config) continue;
        const reservation = this.options.sessionIndex.reserveChildResume(
          parent,
          metadata,
          this.randomUuid()
        );
        if (!reservation.ok) continue;
        const spawned = this.options.host.spawnChild(
          reservation.reservation.child,
          source.parentProjectPath,
          resolved.config,
          resumeFile
        );
        if (!spawned.ok) this.options.sessionIndex.releaseChild(reservation.reservation.child);
        continue;
      }
      // 工具直雇 coworker（无 typed metadata）：双形状过渡命令，worker 侧自带容量豁免
      const name =
        typeof child.coworkerName === 'string' && child.coworkerName
          ? child.coworkerName
          : (coworkerId.split('::cw-').at(-1) ?? coworkerId);
      this.options.host.resumeCoworker(
        parent,
        coworkerId,
        name,
        typeof child.agentType === 'string' ? child.agentType : undefined,
        resumeFile
      );
    }
  }

  private currentOrNewParent(binding: ParentSourceBinding): SessionIdentity {
    const current = this.options.sessionIndex.currentIdentity(binding.parentConversationId);
    if (current) return current;
    const identity = {
      sessionId: binding.parentConversationId,
      generation: this.randomUuid(),
    };
    this.options.sessionIndex.prepareParent(identity);
    return identity;
  }

  private async ensureParentReady(
    binding: ParentSourceBinding & { selectedModel: ModelRef },
    parent: SessionIdentity,
    model: ModelSelection,
    credentialKeys: ReadonlySet<string>
  ): Promise<void> {
    if (this.options.sessionIndex.isReady(parent)) return;
    const key = `${parent.sessionId}\u0000${parent.generation}`;
    const current = this.parentReady.get(key);
    if (current) return current;

    const operation = (async () => {
      const persisted = this.options.sessionIndex.persistedConversation(parent.sessionId) ?? {};
      const request: AgentSpawnRequest = {
        sessionId: parent.sessionId,
        providerId: binding.selectedModel.providerId,
        modelId: binding.selectedModel.modelId,
        cwd: binding.parentProjectPath,
        ...(typeof persisted.sessionFile === 'string' ? { resumeFile: persisted.sessionFile } : {}),
        ...(persisted.reasoningEnabled === true ? { reasoningEnabled: true } : {}),
        ...(typeof persisted.thinkingLevel === 'string'
          ? { thinkingLevel: persisted.thinkingLevel as AgentSpawnRequest['thinkingLevel'] }
          : {}),
        ...(typeof persisted.presetId === 'string' ? { presetId: persisted.presetId } : {}),
        ...(typeof persisted.approvalMode === 'string'
          ? { approvalMode: persisted.approvalMode as AgentSpawnRequest['approvalMode'] }
          : {}),
      };
      const spawned = this.options.host.spawnParent(parent, request, credentialKeys);
      if (!spawned.ok) throw new Error(spawned.error ?? 'Failed to spawn parent container.');
      const ready = await this.waitForParent(parent);
      if (
        ready.model.providerId !== model.ref.providerId ||
        ready.model.modelId !== model.ref.modelId
      ) {
        throw new Error('Parent ready model did not match the bound model.');
      }
    })().finally(() => this.parentReady.delete(key));
    this.parentReady.set(key, operation);
    return operation;
  }

  private waitForParent(
    identity: SessionIdentity
  ): Promise<Extract<ParentLifecycleEvent, { type: 'parent-ready' }>> {
    return this.waitFor(
      (event): event is Extract<ParentLifecycleEvent, { type: 'parent-ready' }> =>
        event.type === 'parent-ready' && isSameGeneration(identity, event.identity),
      (event) =>
        (event.type === 'parent-rejected' || event.type === 'parent-ended') &&
        isSameGeneration(identity, event.identity)
    );
  }

  private waitForChild(
    identity: ChildSessionIdentity,
    signal?: AbortSignal
  ): Promise<Extract<ChildLifecycleEvent, { type: 'child-ready' }>> {
    return this.waitFor(
      (event): event is Extract<ChildLifecycleEvent, { type: 'child-ready' }> =>
        event.type === 'child-ready' && isSameChildSessionIdentity(identity, event.identity),
      (event) =>
        (event.type === 'child-rejected' || event.type === 'child-ended') &&
        isSameChildSessionIdentity(identity, event.identity),
      signal
    );
  }

  private waitFor<T extends AgentWorkerEvent>(
    success: (event: AgentWorkerEvent) => event is T,
    failure: (event: AgentWorkerEvent) => boolean,
    signal?: AbortSignal
  ): Promise<T> {
    const { promise, resolve, reject } = Promise.withResolvers<T>();
    let abortListener: (() => void) | undefined;
    const cleanup = (waiter: EventWaiter) => {
      clearTimeout(waiter.timer);
      this.waiters.delete(waiter);
      if (abortListener && signal) signal.removeEventListener('abort', abortListener);
    };
    const waiter: EventWaiter = {
      accept: (event) => {
        if (event.type === 'worker-exited') {
          cleanup(waiter);
          reject(new Error('Agent worker exited before ready.'));
          return true;
        }
        if (success(event)) {
          cleanup(waiter);
          resolve(event);
          return true;
        }
        if (failure(event)) {
          cleanup(waiter);
          reject(new Error('Agent session was rejected before ready.'));
          return true;
        }
        return false;
      },
      timer: setTimeout(() => {
        cleanup(waiter);
        reject(new Error('Agent session ready handshake timed out.'));
      }, this.readyTimeoutMs),
    };
    abortListener = () => {
      cleanup(waiter);
      reject(new Error('Team operation cancelled before child ready.'));
    };
    if (signal?.aborted) abortListener();
    else {
      if (signal) signal.addEventListener('abort', abortListener, { once: true });
      this.waiters.add(waiter);
    }
    return promise;
  }

  private guardCurrent(guard?: TeamExecutionGuard): boolean {
    if (!guard || guard.signal.aborted === false) {
      if (!guard) return true;
      try {
        return guard.assertExecutionCurrent();
      } catch {
        return false;
      }
    }
    return false;
  }

  private cancelledTeamOperation(): TeamOperationResult {
    return {
      ok: false,
      code: 'unavailable',
      error: 'Team operation cancelled before commit.',
      suggestedAction: 'Retry from the current Agent generation.',
    };
  }

  private verifyChildReady(
    reservation: ChildReservation,
    ready: Extract<ChildLifecycleEvent, { type: 'child-ready' }>,
    config: ResolvedAgentTypeSpawnConfig,
    expectedModel: ModelRef,
    expectedToolIds: readonly string[]
  ): void {
    if (!isSameChildSessionIdentity(reservation.child, ready.identity)) {
      throw new Error('Child ready identity mismatch.');
    }
    const proof = ready.proof;
    const expectedTools = [...expectedToolIds].sort();
    const actualTools = [...proof.toolIds].sort();
    const expectedSkills = [...config.skillBindingIds].sort();
    const actualSkills = [...proof.loadedSkillBindingIds].sort();
    const expectedMcp = [...config.mcpBindingIds].sort();
    const actualMcp = [...proof.loadedMcpBindingIds].sort();
    const sameSet = (left: readonly string[], right: readonly string[]) =>
      left.length === right.length && left.every((value, index) => value === right[index]);
    if (
      ready.identity.typeKey !== config.typeKey ||
      ready.identity.profileId !== config.lockedProfileId ||
      proof.spawnSpecId !== config.spawnSpecId ||
      proof.typeKey !== config.typeKey ||
      proof.model.providerId !== expectedModel.providerId ||
      proof.model.modelId !== expectedModel.modelId ||
      proof.systemPromptHash !== config.systemPromptHash ||
      !sameSet(actualTools, expectedTools) ||
      !sameSet(actualSkills, expectedSkills) ||
      !sameSet(actualMcp, expectedMcp)
    ) {
      throw new Error('Child exact profile proof mismatch.');
    }
    if (
      config.tools !== 'enso-locked' &&
      proof.toolIds.some((toolId) => toolId === 'enso_app' || toolId === 'enso_capabilities')
    ) {
      throw new Error('Ordinary Agent received locked Enso tools.');
    }
  }

  private emitDispatch(
    dispatch: ActiveDispatch,
    event:
      | { phase: DispatchProgressPhase }
      | {
          phase: 'terminal';
          terminal: DispatchTerminal;
          receiptSummary?: string;
        }
  ): void {
    this.options.emitDispatchEvent?.(dispatch.ownerWebContentsId, {
      dispatchId: dispatch.dispatchId,
      child: dispatch.child,
      mainSeq: ++dispatch.seq,
      ...event,
    });
  }

  private snapshotFileMentions(projectPath: string, task: AgentDispatchTask): AgentDispatchTask {
    if (task.fileMentions.length === 0) return task;
    const root = realpathSync(projectPath);
    const prefix = root.endsWith(path.sep) ? root : `${root}${path.sep}`;
    let totalBytes = 0;
    const snapshots = task.fileMentions.map((mention) => {
      if (path.isAbsolute(mention.relativePath)) {
        throw new Error('Absolute file mentions are not allowed.');
      }
      const resolved = realpathSync(path.resolve(root, mention.relativePath));
      if (!resolved.startsWith(prefix)) throw new Error('File mention escapes the bound project.');
      const stat = statSync(resolved);
      if (!stat.isFile() || stat.size > MAX_FILE_MENTION_BYTES) {
        throw new Error('Mentioned file is unavailable or too large.');
      }
      totalBytes += stat.size;
      if (totalBytes > MAX_FILE_MENTION_TOTAL_BYTES) {
        throw new Error('Mentioned files exceed the dispatch size limit.');
      }
      return `<mentioned-file path="${mention.relativePath}">\n${readFileSync(resolved, 'utf8')}\n</mentioned-file>`;
    });
    return {
      ...task,
      text: [task.text, ...snapshots].filter(Boolean).join('\n\n'),
    };
  }

  private rejected(
    request: AgentDispatchRequest,
    code: Extract<AgentDispatchResult, { accepted: false }>['code'],
    message: string,
    action?: Extract<AgentDispatchResult, { accepted: false }>['action']
  ): AgentDispatchResult {
    return {
      accepted: false,
      requestId: request.requestId,
      code,
      message,
      ...(action ? { action } : {}),
    };
  }

  private remember(key: string, result: AgentDispatchResult): void {
    this.recent.set(key, result);
    while (this.recent.size > MAX_RECENT_DISPATCHES) {
      const oldest = this.recent.keys().next().value;
      if (typeof oldest !== 'string') break;
      this.recent.delete(oldest);
    }
  }
}
