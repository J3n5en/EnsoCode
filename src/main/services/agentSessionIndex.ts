import { randomUUID } from 'node:crypto';
import {
  type AgentTypeKey,
  buildAgentTypeRegistrySnapshot,
  type ChildSessionIdentity,
  isSameChildSessionIdentity,
  type SessionIdentity,
} from '@shared/builtinAgents';
import type {
  AgentWorkerEvent,
  ChildConversationMetadata,
  CoworkerInfo,
  McpWorkerEvent,
  ModelRef,
  NodeStatus,
} from '@shared/types/agent';
import { type AgentTypeEntry, BUILTIN_AGENT_TYPES } from '@shared/types/assets';

export const MAX_ORIGIN_COWORKERS = 5;

interface IndexedSession {
  identity: SessionIdentity | ChildSessionIdentity;
  started: boolean;
  ready: boolean;
  alive: boolean;
  status: NodeStatus;
  lastSeq: number;
  model?: ModelRef;
  sessionFile?: string;
  coworkers: Map<string, CoworkerInfo>;
}

export interface ChildReservation {
  requestId: string;
  child: ChildSessionIdentity;
  metadata: ChildConversationMetadata;
}

export type ChildReservationResult =
  | { ok: true; reservation: ChildReservation }
  | { ok: false; code: 'stale-parent' | 'capacity-reached'; error: string };

export interface TeamAgentType {
  typeKey: AgentTypeKey;
  name: string;
  description: string;
  tools: 'all' | 'readonly' | 'enso-locked';
}

export interface TeamTargetUnavailable {
  ok: false;
  code: 'unavailable';
  error: string;
  suggestedAction: string;
}

export interface TeamOperationSuccess {
  ok: true;
  data: {
    conversationId: string;
    coworker: Pick<CoworkerInfo, 'id' | 'name' | 'agentType' | 'status' | 'modelId'>;
  };
}

export type TeamOperationResult = TeamOperationSuccess | TeamTargetUnavailable;

export interface AgentSessionIndexOptions {
  readSettings: () => Record<string, unknown> | null;
  randomUuid?: () => string;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function settingsState(settings: Record<string, unknown> | null): Record<string, unknown> {
  const store = record(settings?.['enso-settings']);
  return record(store?.state) ?? {};
}

function conversationState(settings: Record<string, unknown> | null): Record<string, unknown> {
  const store = record(settings?.['enso-conversations']);
  return record(store?.state) ?? {};
}

function coworkerView(coworker: CoworkerInfo): TeamOperationSuccess['data']['coworker'] {
  return {
    id: coworker.id,
    name: coworker.name,
    ...(coworker.agentType ? { agentType: coworker.agentType } : {}),
    status: coworker.status,
    ...(coworker.modelId ? { modelId: coworker.modelId } : {}),
  };
}

function identityOf(
  event: Exclude<
    AgentWorkerEvent,
    | { type: 'snapshot' }
    | { type: 'title-generated' }
    | { type: 'memory-pipeline-done' }
    | McpWorkerEvent
  >
): SessionIdentity {
  return 'child' in event ? event.child : event.identity;
}

function isSameGeneration(left: SessionIdentity, right: SessionIdentity): boolean {
  return left.sessionId === right.sessionId && left.generation === right.generation;
}

function isAgentTypeEntry(value: unknown): value is AgentTypeEntry {
  const entry = record(value);
  return Boolean(
    entry &&
      typeof entry.id === 'string' &&
      typeof entry.name === 'string' &&
      typeof entry.description === 'string' &&
      typeof entry.systemPrompt === 'string' &&
      (entry.tools === 'all' || entry.tools === 'readonly') &&
      (entry.writeScope === undefined ||
        (Array.isArray(entry.writeScope) &&
          entry.writeScope.every((glob) => typeof glob === 'string' && glob.trim() !== '')))
  );
}
export class AgentSessionIndex {
  private readonly sessions = new Map<string, IndexedSession>();
  private readonly reservations = new Map<string, ChildReservation>();
  private readonly randomUuid: () => string;

  constructor(private readonly options: AgentSessionIndexOptions) {
    this.randomUuid = options.randomUuid ?? randomUUID;
  }

  prepareParent(identity: SessionIdentity): void {
    const current = this.sessions.get(identity.sessionId);
    if (current && isSameGeneration(current.identity, identity)) return;
    this.releaseParentReservations(identity.sessionId);
    this.sessions.set(identity.sessionId, {
      identity,
      started: false,
      ready: false,
      alive: true,
      status: 'idle',
      lastSeq: -1,
      coworkers: current?.coworkers ?? new Map(),
    });
  }

  currentIdentity(sessionId: string): SessionIdentity | ChildSessionIdentity | undefined {
    return this.sessions.get(sessionId)?.identity;
  }

  isCurrent(identity: SessionIdentity): boolean {
    const current = this.sessions.get(identity.sessionId);
    return Boolean(current && isSameGeneration(current.identity, identity));
  }

  isReady(identity: SessionIdentity): boolean {
    const current = this.sessions.get(identity.sessionId);
    return Boolean(current?.ready && current.alive && isSameGeneration(current.identity, identity));
  }

  sessionFile(identity: SessionIdentity): string | undefined {
    const current = this.sessions.get(identity.sessionId);
    return current && isSameGeneration(current.identity, identity)
      ? current.sessionFile
      : undefined;
  }

  model(identity: SessionIdentity): ModelRef | undefined {
    const current = this.sessions.get(identity.sessionId);
    return current && isSameGeneration(current.identity, identity) ? current.model : undefined;
  }

  reserveChild(
    parent: SessionIdentity,
    typeKey: AgentTypeKey,
    displayName: string,
    requestId: string,
    profileId?: ChildSessionIdentity['profileId']
  ): ChildReservationResult {
    const session = this.sessions.get(parent.sessionId);
    if (!session || !isSameGeneration(session.identity, parent)) {
      return { ok: false, code: 'stale-parent', error: 'Parent generation is no longer current.' };
    }
    const occupied = session.coworkers.size + this.parentReservations(parent).length;
    if (occupied >= MAX_ORIGIN_COWORKERS) {
      return {
        ok: false,
        code: 'capacity-reached',
        error: `Coworker limit reached (${MAX_ORIGIN_COWORKERS} active or reserved).`,
      };
    }

    let instanceId = this.randomUuid();
    let instanceName = this.instanceName(displayName, instanceId);
    const usedNames = this.usedNames(parent.sessionId);
    while (usedNames.has(instanceName)) {
      instanceId = this.randomUuid();
      instanceName = this.instanceName(displayName, instanceId);
    }
    const child: ChildSessionIdentity = {
      sessionId: `${parent.sessionId}::cw-${instanceId}`,
      generation: this.randomUuid(),
      parent,
      instanceId,
      instanceName,
      typeKey,
      ...(profileId ? { profileId } : {}),
    };
    const reservation: ChildReservation = {
      requestId,
      child,
      metadata: {
        parentId: parent.sessionId,
        childGeneration: child.generation,
        agentTypeKey: child.typeKey,
        agentInstanceId: child.instanceId,
        agentInstanceName: child.instanceName,
        dispatchOrigin: 'typed-mention',
        ...(profileId ? { lockedProfileId: profileId } : {}),
      },
    };
    this.reservations.set(child.sessionId, reservation);
    return { ok: true, reservation };
  }

  /**
   * 重启后恢复 typed child 的预约变体（§7.3）：原 instanceId/instanceName/typeKey/
   * lockedProfileId 不变，只换新 generation；名字已被占用拒绝，不得换名降级。
   * 容量与 reserveChild 共用 occupied 计数。
   */
  reserveChildResume(
    parent: SessionIdentity,
    metadata: ChildConversationMetadata,
    requestId: string
  ): ChildReservationResult {
    const session = this.sessions.get(parent.sessionId);
    if (!session || !isSameGeneration(session.identity, parent)) {
      return { ok: false, code: 'stale-parent', error: 'Parent generation is no longer current.' };
    }
    const occupied = session.coworkers.size + this.parentReservations(parent).length;
    if (occupied >= MAX_ORIGIN_COWORKERS) {
      return {
        ok: false,
        code: 'capacity-reached',
        error: `Coworker limit reached (${MAX_ORIGIN_COWORKERS} active or reserved).`,
      };
    }
    // 撞名检查要排除自身：usedNames 扫持久化防跨重启撞名，而 resume 的 child
    // 自己的名字必然在盘上，算冲突会让所有 typed child 永远恢复失败。
    const sessionId = `${parent.sessionId}::cw-${metadata.agentInstanceId}`;
    // 同一 child 已在恢复中（并发/重入）→ 拒绝，防 reservation 被静默覆盖
    if (this.reservations.has(sessionId)) {
      return {
        ok: false,
        code: 'capacity-reached',
        error: `Coworker resume is already in flight: ${metadata.agentInstanceName}`,
      };
    }
    if (this.nameTakenByOther(parent.sessionId, metadata.agentInstanceName, sessionId)) {
      return {
        ok: false,
        code: 'capacity-reached',
        error: `Coworker name is already in use: ${metadata.agentInstanceName}`,
      };
    }
    const child: ChildSessionIdentity = {
      sessionId,
      generation: this.randomUuid(),
      parent,
      instanceId: metadata.agentInstanceId,
      instanceName: metadata.agentInstanceName,
      typeKey: metadata.agentTypeKey,
      ...(metadata.lockedProfileId ? { profileId: metadata.lockedProfileId } : {}),
    };
    const reservation: ChildReservation = {
      requestId,
      child,
      metadata: { ...metadata, childGeneration: child.generation },
    };
    this.reservations.set(child.sessionId, reservation);
    return { ok: true, reservation };
  }

  reservation(child: ChildSessionIdentity): ChildReservation | undefined {
    const current = this.reservations.get(child.sessionId);
    return current && isSameChildSessionIdentity(current.child, child) ? current : undefined;
  }

  releaseChild(child: ChildSessionIdentity): boolean {
    const current = this.reservations.get(child.sessionId);
    if (!current || !isSameChildSessionIdentity(current.child, child)) return false;
    this.reservations.delete(child.sessionId);
    return true;
  }

  observe(event: AgentWorkerEvent | { type: 'worker-exited' }): boolean {
    if (event.type === 'worker-exited') {
      for (const session of this.sessions.values()) {
        session.alive = false;
        session.ready = false;
        // worker 重建后会话 seq 从 0 重计；不重置则 parent-ready 被当重复丢弃，索引永远不 ready
        session.lastSeq = -1;
      }
      this.reservations.clear();
      return true;
    }
    if (event.type === 'snapshot') {
      if (!event.partial) {
        for (const session of this.sessions.values()) {
          if (session.lastSeq < 0) session.alive = false;
        }
      }
      let accepted = false;
      for (const snapshot of event.sessions) {
        const current = this.sessions.get(snapshot.identity.sessionId);
        if (
          !current ||
          !isSameGeneration(current.identity, snapshot.identity) ||
          current.lastSeq >= 0
        ) {
          continue;
        }
        current.alive = snapshot.status !== 'failed';
        current.status = snapshot.status;
        accepted = true;
      }
      return accepted;
    }

    // 标题总结与 MCP 旁路事件不属于任何 worker 会话（无 identity/seq），不进会话索引
    if (event.type === 'title-generated' || event.type === 'memory-pipeline-done') return false;
    if (event.type === 'mcp-status' || event.type === 'mcp-tokens-refreshed') return false;

    const identity = identityOf(event);
    const current = this.sessions.get(identity.sessionId);
    if (current && !isSameGeneration(current.identity, identity)) return false;
    // 拒绝恒以 seq:0 发出（也可能针对已跑过的同代会话），不过单调守卫
    if (current && event.type !== 'parent-rejected') {
      if (event.seq <= current.lastSeq) return false;
      current.lastSeq = event.seq;
    }

    if (event.type === 'parent-ready') {
      const parent = current ?? this.createIndexed(event.identity);
      parent.lastSeq = event.seq;
      parent.started = true;
      parent.ready = true;
      parent.alive = true;
      parent.sessionFile = event.sessionFile;
      parent.model = event.model;
      return true;
    }
    // 就地换模型：不更新这里，activeConversationRegistry 的 selection 校验会永远拿旧模型比对。
    if (event.type === 'model-changed') {
      if (!current || !isSameGeneration(current.identity, event.identity)) return false;
      current.model = event.model;
      current.lastSeq = event.seq;
      return true;
    }
    if (event.type === 'parent-rejected' || event.type === 'parent-ended') {
      if (!current) return false;
      current.ready = false;
      current.alive = false;
      current.status = 'failed';
      // ended/rejected 是该 worker 会话的末事件；同 generation 重建（驱逐后 resume）seq 从 0 重计
      current.lastSeq = -1;
      this.releaseParentReservations(identity.sessionId);
      return true;
    }
    if (event.type === 'child-ready') {
      const reservation = this.reservation(event.identity);
      if (!reservation) return false;
      const parent = this.sessions.get(event.identity.parent.sessionId);
      if (!parent || !isSameGeneration(parent.identity, event.identity.parent)) return false;
      this.reservations.delete(event.identity.sessionId);
      parent.coworkers.set(event.identity.sessionId, {
        id: event.identity.sessionId,
        child: reservation.metadata,
        name: event.identity.instanceName,
        agentType: event.identity.typeKey,
        status: 'idle',
        modelId: event.proof.model.modelId,
        sessionFile: event.sessionFile,
        createdAt: Date.now(),
      });
      this.sessions.set(event.identity.sessionId, {
        identity: event.identity,
        started: true,
        ready: true,
        alive: true,
        status: 'idle',
        lastSeq: event.seq,
        model: event.proof.model,
        sessionFile: event.sessionFile,
        coworkers: new Map(),
      });
      return true;
    }
    if (event.type === 'child-rejected' || event.type === 'child-ended') {
      this.releaseChild(event.identity);
      const parent = this.sessions.get(event.identity.parent.sessionId);
      parent?.coworkers.delete(event.identity.sessionId);
      const child = this.sessions.get(event.identity.sessionId);
      if (child && isSameGeneration(child.identity, event.identity)) {
        child.ready = false;
        child.alive = false;
        child.status = 'failed';
      }
      return true;
    }
    if (!current) return false;
    if (event.type === 'status') {
      current.started = true;
      current.status = event.status;
      current.alive = event.status !== 'failed';
      return true;
    }
    if (event.type === 'session-meta') {
      current.started = true;
      current.alive = true;
      if (event.sessionFile) current.sessionFile = event.sessionFile;
      return true;
    }
    if (event.type === 'coworker-update') {
      if (event.coworker.status === 'dismissed') {
        current.coworkers.delete(event.coworker.id);
        // typed child 由 child-ended 收口;这里只清工具直雇的裸身份
        const indexed = this.sessions.get(event.coworker.id);
        if (indexed && !('parent' in indexed.identity)) this.sessions.delete(event.coworker.id);
      } else {
        current.coworkers.set(event.coworker.id, { ...event.coworker });
        // 工具直雇 coworker 没有 child-ready,靠这里入索引,否则用户 tab 的 prompt 会被 exactIdentity 拒掉
        if (event.coworkerIdentity) {
          this.sessions.set(event.coworker.id, {
            identity: event.coworkerIdentity,
            started: true,
            ready: true,
            alive: true,
            status: 'idle',
            lastSeq: -1,
            ...(event.coworker.sessionFile ? { sessionFile: event.coworker.sessionFile } : {}),
            coworkers: new Map(),
          });
        }
      }
      return true;
    }
    return true;
  }

  listAgentTypes(): TeamAgentType[] {
    const state = settingsState(this.options.readSettings());
    const disabledBuiltinAgentTypes = Array.isArray(state.disabledBuiltinAgentTypes)
      ? state.disabledBuiltinAgentTypes.filter((name): name is string => typeof name === 'string')
      : [];
    const customAgentTypes = Array.isArray(state.agentTypes)
      ? state.agentTypes.filter(isAgentTypeEntry)
      : [];
    const snapshot = buildAgentTypeRegistrySnapshot({
      revision: 0,
      disabledBuiltinAgentTypes,
      customAgentTypes,
    });
    return snapshot.candidates.map((candidate) => {
      const tools =
        candidate.typeKey === 'agent:enso'
          ? 'enso-locked'
          : candidate.typeKey.startsWith('builtin:')
            ? (BUILTIN_AGENT_TYPES.find((entry) => `builtin:${entry.name}` === candidate.typeKey)
                ?.tools ?? 'all')
            : (customAgentTypes.find((entry) => `custom:${entry.id}` === candidate.typeKey)
                ?.tools ?? 'all');
      return {
        typeKey: candidate.typeKey,
        name: candidate.displayName,
        description: candidate.description,
        tools,
      };
    });
  }

  listCoworkers(
    conversationId: string | undefined
  ): { ok: true; data: TeamOperationSuccess['data']['coworker'][] } | TeamTargetUnavailable {
    const target = this.resolveTeamTarget(conversationId);
    if (!target.ok) return target;
    return {
      ok: true,
      data: Array.from(target.coworkers.values(), coworkerView),
    };
  }

  resolveTeamTarget(conversationId: string | undefined):
    | {
        ok: true;
        conversationId: string;
        identity: SessionIdentity;
        coworkers: ReadonlyMap<string, CoworkerInfo>;
      }
    | TeamTargetUnavailable {
    if (!conversationId) {
      return this.unavailable(
        'No origin conversation is bound to this child.',
        'Open or resume a coding conversation first.'
      );
    }
    const session = this.sessions.get(conversationId);
    if (!session?.ready || !session.alive || session.status === 'failed') {
      return this.unavailable(
        'The origin conversation is not ready.',
        'Open or resume the coding conversation, then retry.'
      );
    }
    return {
      ok: true,
      conversationId,
      identity: session.identity,
      coworkers: session.coworkers,
    };
  }

  /** 按 exact 父身份查 worker 直雇 coworker（只在 parent.coworkers 映射、不在 sessions 索引） */
  coworkerOf(parent: SessionIdentity, coworkerId: string): CoworkerInfo | undefined {
    const session = this.sessions.get(parent.sessionId);
    if (!session || !isSameGeneration(session.identity, parent)) return undefined;
    return session.coworkers.get(coworkerId);
  }

  persistedConversation(conversationId: string): Record<string, unknown> | null {
    const state = conversationState(this.options.readSettings());
    return record(record(state.conversations)?.[conversationId]);
  }

  private createIndexed(identity: SessionIdentity): IndexedSession {
    const created: IndexedSession = {
      identity,
      started: false,
      ready: false,
      alive: true,
      status: 'idle',
      lastSeq: -1,
      coworkers: new Map(),
    };
    this.sessions.set(identity.sessionId, created);
    return created;
  }

  private parentReservations(parent: SessionIdentity): ChildReservation[] {
    return Array.from(this.reservations.values()).filter((reservation) =>
      isSameGeneration(parent, reservation.child.parent)
    );
  }

  private releaseParentReservations(parentSessionId: string): void {
    for (const [childId, reservation] of this.reservations) {
      if (reservation.child.parent.sessionId === parentSessionId) this.reservations.delete(childId);
    }
  }

  /** resume 专用撞名检查：排除被恢复 child 自身的内存/持久化条目 */
  private nameTakenByOther(parentSessionId: string, name: string, selfSessionId: string): boolean {
    const parent = this.sessions.get(parentSessionId);
    for (const coworker of parent?.coworkers.values() ?? []) {
      if (coworker.name === name && coworker.id !== selfSessionId) return true;
    }
    for (const reservation of this.reservations.values()) {
      if (
        reservation.child.parent.sessionId === parentSessionId &&
        reservation.child.instanceName === name &&
        reservation.child.sessionId !== selfSessionId
      ) {
        return true;
      }
    }
    const conversations = record(conversationState(this.options.readSettings()).conversations);
    if (conversations) {
      for (const [conversationId, value] of Object.entries(conversations)) {
        if (conversationId === selfSessionId) continue;
        const conversation = record(value);
        if (conversation?.parentId !== parentSessionId) continue;
        const persistedName = conversation.agentInstanceName ?? conversation.coworkerName;
        if (persistedName === name) return true;
      }
    }
    return false;
  }

  private usedNames(parentSessionId: string): Set<string> {
    const names = new Set<string>();
    const parent = this.sessions.get(parentSessionId);
    for (const coworker of parent?.coworkers.values() ?? []) names.add(coworker.name);
    for (const reservation of this.reservations.values()) {
      if (reservation.child.parent.sessionId === parentSessionId) {
        names.add(reservation.child.instanceName);
      }
    }
    const conversations = record(conversationState(this.options.readSettings()).conversations);
    if (conversations) {
      for (const value of Object.values(conversations)) {
        const conversation = record(value);
        if (conversation?.parentId !== parentSessionId) continue;
        const name = conversation.agentInstanceName ?? conversation.coworkerName;
        if (typeof name === 'string') names.add(name);
      }
    }
    return names;
  }

  private instanceName(displayName: string, instanceId: string): string {
    const base = displayName.trim() || 'Agent';
    return `${base}-${instanceId.slice(0, 8)}`;
  }

  private unavailable(error: string, suggestedAction: string): TeamTargetUnavailable {
    return { ok: false, code: 'unavailable', error, suggestedAction };
  }
}
