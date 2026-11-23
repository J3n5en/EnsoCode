import path from 'node:path';
import { app } from '@platform';
import {
  type DemandMilestoneKind,
  type DemandMilestoneRecord,
  type DemandThreadPr,
  type DemandThreadRecord,
  type DemandThreadSource,
  type DemandThreadStatus,
  type DemandThreadView,
  demandPrKey,
  demandSourceKey,
  normalizeDemandChannel,
  parseClaimKeyTarget,
  parseDemandPr,
  parseDemandSource,
  parseDemandStatus,
} from '@shared/types/demandThreads';
import type { SecretaryDemandThreadView } from '@shared/types/secretary';
import { readJson, writeJsonAtomic } from './bots/files';
import { peekEventClaimStore } from './eventClaims';
import { isBoundOwner, type OwnerBindings } from './extensionPlugins/injectTrust';

export interface DemandThreadStoreOptions {
  filePath?: string;
  now?: () => number;
  resolveIsOwner?: (source: DemandThreadSource) => boolean;
}

export interface DemandThreadOpenInput {
  source: DemandThreadSource;
  sessionId: string;
  pluginId?: string;
  subagentId?: string;
  secretaryId?: string;
  pr?: DemandThreadPr;
}

export interface DemandThreadListFilter {
  status?: DemandThreadStatus;
  sessionId?: string;
  repo?: string;
  activeOnly?: boolean;
}

type Listener = () => void;

let demandOwnerResolver: ((source: DemandThreadSource) => boolean) | null = null;
let demandSessionReassignedHook: ((info: DemandSessionReassigned) => void) | null = null;

export interface DemandSessionReassigned {
  threadId: string;
  previousSessionId: string;
  nextSessionId: string;
  pr?: DemandThreadPr;
  source: DemandThreadSource;
}

export function setDemandOwnerResolver(
  resolver: ((source: DemandThreadSource) => boolean) | null
): void {
  demandOwnerResolver = resolver;
}

export function setDemandSessionReassignedHook(
  hook: ((info: DemandSessionReassigned) => void) | null
): void {
  demandSessionReassignedHook = hook;
}

export function demandRequesterIsOwner(
  source: DemandThreadSource,
  bindings: OwnerBindings
): boolean {
  if (!source.senderId) return false;
  return isBoundOwner({ channel: source.channel, userId: source.senderId }, bindings);
}

export function releaseReassignedDemandClaims(info: DemandSessionReassigned): void {
  const claims = peekEventClaimStore();
  if (!claims) return;
  const tg = `tg:${info.source.chatId}:${info.source.messageId}`;
  const github = info.pr ? `github:${info.pr.repo.toLowerCase()}#${info.pr.number}:` : null;
  for (const claim of claims.list({ sessionId: info.previousSessionId })) {
    const matchesTg = claim.key === tg || claim.key.startsWith(`${tg}:`);
    const matchesPr = github !== null && claim.key.startsWith(github);
    if (matchesTg || matchesPr) claims.release(claim.key, info.previousSessionId);
  }
}

export function demandMilestoneSent(
  records: readonly DemandMilestoneRecord[],
  kind: DemandMilestoneKind,
  dedupeKey?: string
): boolean {
  if (dedupeKey === undefined) return records.some((item) => item.kind === kind);
  return records.some(
    (item) => item.kind === kind && (item.dedupeKey === undefined || item.dedupeKey === dedupeKey)
  );
}

function viewOf(thread: DemandThreadRecord): DemandThreadView {
  return {
    ...thread,
    source: { ...thread.source },
    ...(thread.pr ? { pr: { ...thread.pr } } : {}),
    milestonesSent: thread.milestonesSent.map((item) => ({ ...item })),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export class DemandThreadStore {
  private readonly filePath?: string;
  private readonly now: () => number;
  private readonly resolveIsOwner: (source: DemandThreadSource) => boolean;
  private readonly byId = new Map<string, DemandThreadRecord>();
  private readonly bySource = new Map<string, string>();
  private readonly byPr = new Map<string, string>();
  private readonly bySession = new Map<string, Set<string>>();
  private readonly listeners = new Set<Listener>();
  private seq = 0;

  constructor(options: DemandThreadStoreOptions = {}) {
    this.filePath = options.filePath;
    this.now = options.now ?? Date.now;
    this.resolveIsOwner =
      options.resolveIsOwner ?? ((source) => demandOwnerResolver?.(source) ?? false);
    this.load();
  }

  open(input: DemandThreadOpenInput): DemandThreadView {
    const source = canonicalSource(input.source);
    const key = demandSourceKey(source);
    const existing = this.byId.get(this.bySource.get(key) ?? '');
    const now = this.now();
    if (existing) {
      if (existing.pluginId && input.pluginId && existing.pluginId !== input.pluginId) {
        throw new Error('线程归属其他插件');
      }
      const previousSessionId = existing.sessionId;
      const claimPr = existing.pr ? { ...existing.pr } : undefined;
      this.attachSession(existing.id, input.sessionId, existing.sessionId);
      if (input.subagentId !== undefined) existing.subagentId = input.subagentId;
      if (input.secretaryId !== undefined) existing.secretaryId = input.secretaryId;
      if (input.pr) this.indexPr(existing, input.pr);
      existing.updatedAt = now;
      this.noteReassign(existing, previousSessionId, input.sessionId, claimPr ?? existing.pr);
      this.persist();
      this.emit();
      return viewOf(existing);
    }
    const thread: DemandThreadRecord = {
      id: `dt_${now.toString(36)}_${this.seq++}`,
      source,
      requesterIsOwner: this.resolveIsOwner(source),
      sessionId: input.sessionId,
      ...(input.pluginId !== undefined ? { pluginId: input.pluginId } : {}),
      ...(input.subagentId !== undefined ? { subagentId: input.subagentId } : {}),
      ...(input.secretaryId !== undefined ? { secretaryId: input.secretaryId } : {}),
      status: 'open',
      milestonesSent: [],
      createdAt: now,
      updatedAt: now,
    };
    this.byId.set(thread.id, thread);
    this.bySource.set(key, thread.id);
    this.attachSession(thread.id, input.sessionId);
    if (input.pr) this.indexPr(thread, input.pr);
    this.persist();
    this.emit();
    return viewOf(thread);
  }

  bindPr(
    target: { threadId?: string; sessionId?: string },
    pr: DemandThreadPr
  ): DemandThreadView | null {
    const thread = target.threadId
      ? this.byId.get(target.threadId)
      : target.sessionId
        ? this.activeRecords(target.sessionId)[0]
        : undefined;
    if (!thread) return null;
    this.indexPr(thread, pr);
    if (thread.status === 'open' || thread.status === 'in_progress') thread.status = 'pr_opened';
    thread.updatedAt = this.now();
    this.persist();
    this.emit();
    return viewOf(thread);
  }

  updateStatus(
    threadId: string,
    status: DemandThreadStatus,
    patch?: { sessionId?: string; subagentId?: string; pr?: DemandThreadPr }
  ): DemandThreadView | null {
    const thread = this.byId.get(threadId);
    if (!thread) return null;
    const previousSessionId = thread.sessionId;
    const claimPr = thread.pr ? { ...thread.pr } : undefined;
    thread.status = status;
    if (patch?.sessionId) this.attachSession(thread.id, patch.sessionId, thread.sessionId);
    if (patch?.subagentId !== undefined) thread.subagentId = patch.subagentId;
    if (patch?.pr) this.indexPr(thread, patch.pr);
    if ((status === 'merged' || status === 'closed') && thread.completedAt === undefined) {
      thread.completedAt = this.now();
    }
    thread.updatedAt = this.now();
    if (patch?.sessionId) {
      this.noteReassign(thread, previousSessionId, patch.sessionId, claimPr ?? thread.pr);
    }
    this.persist();
    this.emit();
    return viewOf(thread);
  }

  recordMilestone(
    threadId: string,
    kind: DemandMilestoneKind,
    info?: { dedupeKey?: string; summary?: string; replyMessageId?: string }
  ): boolean {
    const thread = this.byId.get(threadId);
    if (!thread) return false;
    if (demandMilestoneSent(thread.milestonesSent, kind, info?.dedupeKey)) return false;
    thread.milestonesSent.push({
      kind,
      sentAt: this.now(),
      ...(info?.dedupeKey !== undefined ? { dedupeKey: info.dedupeKey } : {}),
      ...(info?.summary !== undefined ? { summary: info.summary } : {}),
      ...(info?.replyMessageId !== undefined ? { replyMessageId: info.replyMessageId } : {}),
    });
    thread.updatedAt = this.now();
    this.persist();
    this.emit();
    return true;
  }

  findById(id: string): DemandThreadView | null {
    const thread = this.byId.get(id);
    return thread ? viewOf(thread) : null;
  }

  findBySource(channel: string, chatId: string, messageId: string): DemandThreadView | null {
    const id = this.bySource.get(
      demandSourceKey({ channel: normalizeDemandChannel(channel), chatId, messageId })
    );
    const thread = id ? this.byId.get(id) : undefined;
    return thread ? viewOf(thread) : null;
  }

  findByPr(repo: string, number: number): DemandThreadView | null {
    const thread = this.byId.get(this.byPr.get(demandPrKey(repo, number)) ?? '');
    return thread ? viewOf(thread) : null;
  }

  findBySession(sessionId: string): DemandThreadView[] {
    return this.sessionRecords(sessionId).map(viewOf);
  }

  findActiveBySession(sessionId: string): DemandThreadView[] {
    return this.activeRecords(sessionId).map(viewOf);
  }

  list(filter: DemandThreadListFilter = {}): DemandThreadView[] {
    const repo = filter.repo?.toLowerCase();
    return [...this.byId.values()]
      .filter((thread) => {
        if (filter.status && thread.status !== filter.status) return false;
        if (filter.sessionId && thread.sessionId !== filter.sessionId) return false;
        if (filter.activeOnly && !isActiveStatus(thread.status)) return false;
        if (repo && thread.pr?.repo.toLowerCase() !== repo) return false;
        return true;
      })
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .map(viewOf);
  }

  onChanged(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  resolveOwnerForClaimKey(key: string): string | null {
    const target = parseClaimKeyTarget(key);
    if (!target) return null;
    const thread =
      target.kind === 'pr'
        ? this.byId.get(this.byPr.get(demandPrKey(target.repo, target.number)) ?? '')
        : this.byId.get(
            this.bySource.get(
              demandSourceKey({
                channel: 'telegram',
                chatId: target.chatId,
                messageId: target.messageId,
              })
            ) ?? ''
          );
    if (!thread || thread.status === 'closed') return null;
    return thread.sessionId;
  }

  private activeRecords(sessionId: string): DemandThreadRecord[] {
    return this.sessionRecords(sessionId).filter((thread) => isActiveStatus(thread.status));
  }

  private sessionRecords(sessionId: string): DemandThreadRecord[] {
    const ids = this.bySession.get(sessionId);
    if (!ids) return [];
    return [...ids]
      .map((id) => this.byId.get(id))
      .filter((thread): thread is DemandThreadRecord => thread !== undefined)
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }

  private attachSession(id: string, sessionId: string, previous?: string): void {
    const thread = this.byId.get(id);
    if (thread) thread.sessionId = sessionId;
    if (previous && previous !== sessionId) this.bySession.get(previous)?.delete(id);
    const bucket = this.bySession.get(sessionId) ?? new Set<string>();
    bucket.add(id);
    this.bySession.set(sessionId, bucket);
  }

  private noteReassign(
    thread: DemandThreadRecord,
    previousSessionId: string,
    nextSessionId: string,
    pr?: DemandThreadPr
  ): void {
    if (previousSessionId === nextSessionId) return;
    demandSessionReassignedHook?.({
      threadId: thread.id,
      previousSessionId,
      nextSessionId,
      ...(pr ? { pr: { ...pr } } : {}),
      source: { ...thread.source },
    });
  }

  private indexPr(thread: DemandThreadRecord, pr: DemandThreadPr): void {
    const key = demandPrKey(pr.repo, pr.number);
    if (thread.pr) {
      const old = demandPrKey(thread.pr.repo, thread.pr.number);
      if (old !== key && this.byPr.get(old) === thread.id) this.byPr.delete(old);
    }
    const occupied = this.byPr.get(key);
    if (occupied && occupied !== thread.id) {
      const other = this.byId.get(occupied);
      if (other?.pr && demandPrKey(other.pr.repo, other.pr.number) === key) delete other.pr;
    }
    thread.pr = { ...thread.pr, ...pr };
    this.byPr.set(key, thread.id);
  }

  private load(): void {
    if (!this.filePath) return;
    const raw = readJson(this.filePath);
    if (!isRecord(raw) || !Array.isArray(raw.threads)) return;
    for (const item of raw.threads) {
      const thread = parseStored(item);
      if (!thread) continue;
      this.byId.set(thread.id, thread);
      this.bySource.set(demandSourceKey(thread.source), thread.id);
      this.attachSession(thread.id, thread.sessionId);
      if (thread.pr) this.byPr.set(demandPrKey(thread.pr.repo, thread.pr.number), thread.id);
    }
  }

  private persist(): void {
    if (!this.filePath) return;
    writeJsonAtomic(this.filePath, { threads: [...this.byId.values()] });
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }
}

function isActiveStatus(status: DemandThreadStatus): boolean {
  return status !== 'merged' && status !== 'closed';
}

function canonicalSource(source: DemandThreadSource): DemandThreadSource {
  return { ...source, channel: normalizeDemandChannel(source.channel) };
}

function parseStored(raw: unknown): DemandThreadRecord | null {
  if (!isRecord(raw)) return null;
  const source = parseDemandSource(raw.source);
  const status = parseDemandStatus(raw.status);
  const id = typeof raw.id === 'string' && raw.id ? raw.id : null;
  const sessionId = typeof raw.sessionId === 'string' && raw.sessionId ? raw.sessionId : null;
  if (!source || !status || !id || !sessionId) return null;
  if (typeof raw.requesterIsOwner !== 'boolean') return null;
  if (!isTime(raw.createdAt) || !isTime(raw.updatedAt)) return null;
  const pr = raw.pr === undefined ? undefined : parseDemandPr(raw.pr);
  if (raw.pr !== undefined && !pr) return null;
  const milestones = parseMilestones(raw.milestonesSent);
  if (!milestones) return null;
  const subagentId = optionalId(raw.subagentId);
  const secretaryId = optionalId(raw.secretaryId);
  const pluginId = optionalId(raw.pluginId);
  if (subagentId === null || secretaryId === null) return null;
  if (pluginId === null) return null;
  const completedAt = raw.completedAt === undefined ? undefined : raw.completedAt;
  if (completedAt !== undefined && !isTime(completedAt)) return null;
  return {
    id,
    source,
    requesterIsOwner: raw.requesterIsOwner,
    sessionId,
    ...(pluginId !== undefined ? { pluginId } : {}),
    ...(subagentId !== undefined ? { subagentId } : {}),
    ...(secretaryId !== undefined ? { secretaryId } : {}),
    ...(pr ? { pr } : {}),
    status,
    milestonesSent: milestones,
    createdAt: raw.createdAt,
    updatedAt: raw.updatedAt,
    ...(completedAt !== undefined ? { completedAt } : {}),
  };
}

function parseMilestones(raw: unknown): DemandMilestoneRecord[] | null {
  if (!Array.isArray(raw)) return null;
  const milestones: DemandMilestoneRecord[] = [];
  for (const item of raw) {
    if (!isRecord(item) || !isMilestoneKind(item.kind)) return null;
    if (!isTime(item.sentAt)) return null;
    const dedupeKey = optionalId(item.dedupeKey);
    const summary = optionalId(item.summary);
    const replyMessageId = optionalId(item.replyMessageId);
    if (dedupeKey === null || summary === null || replyMessageId === null) return null;
    milestones.push({
      kind: item.kind,
      sentAt: item.sentAt,
      ...(dedupeKey !== undefined ? { dedupeKey } : {}),
      ...(summary !== undefined ? { summary } : {}),
      ...(replyMessageId !== undefined ? { replyMessageId } : {}),
    });
  }
  return milestones;
}

function isMilestoneKind(kind: unknown): kind is DemandMilestoneKind {
  return (
    kind === 'pr_opened' || kind === 'ci_failed' || kind === 'needs_human' || kind === 'merged'
  );
}

function optionalId(value: unknown): string | undefined | null {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !value) return null;
  return value;
}

function isTime(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

let singleton: DemandThreadStore | null = null;

export function getDemandThreadStore(): DemandThreadStore {
  if (!singleton) {
    singleton = new DemandThreadStore({
      filePath: path.join(app.getPath('userData'), 'demand-threads.json'),
    });
  }
  return singleton;
}

export function peekDemandThreadStore(): DemandThreadStore | null {
  return singleton;
}

export function secretaryDemandThreadViews(
  rows: Record<string, Record<string, unknown>>
): SecretaryDemandThreadView[] {
  const store = peekDemandThreadStore();
  if (!store) return [];
  return store.list().map((thread) => {
    const row = rows[thread.sessionId];
    const title = row?.title;
    return {
      id: thread.id,
      channel: thread.source.channel,
      chatId: thread.source.chatId,
      messageId: thread.source.messageId,
      ...(thread.source.topicId ? { topicId: thread.source.topicId } : {}),
      ...(thread.source.senderName ? { senderName: thread.source.senderName } : {}),
      ...(thread.source.summary ? { summary: thread.source.summary } : {}),
      requesterIsOwner: thread.requesterIsOwner,
      sessionId: thread.sessionId,
      sessionTitle: typeof title === 'string' && title.trim() ? title : thread.sessionId,
      ...(thread.subagentId ? { subagentId: thread.subagentId } : {}),
      ...(thread.pr
        ? {
            pr: {
              repo: thread.pr.repo,
              number: thread.pr.number,
              ...(thread.pr.url ? { url: thread.pr.url } : {}),
              ...(thread.pr.title ? { title: thread.pr.title } : {}),
            },
          }
        : {}),
      status: thread.status,
      milestones: thread.milestonesSent.map((item) => item.kind),
      createdAt: thread.createdAt,
      updatedAt: thread.updatedAt,
      ...(thread.completedAt !== undefined ? { completedAt: thread.completedAt } : {}),
    };
  });
}

export function setDemandThreadStore(store: DemandThreadStore | null): void {
  singleton = store;
}
