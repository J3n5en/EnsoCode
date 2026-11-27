import { randomBytes, timingSafeEqual } from 'node:crypto';
import {
  buildTriggerUrls,
  MAX_TRIGGERS_PER_SECRETARY,
  parseTriggerCreateDraft,
  parseTriggerPort,
  parseTriggerUpdateDraft,
  type TriggerInboundEvent,
} from '@shared/secretary/triggers';
import type {
  SecretaryAuditEntry,
  SecretaryTrigger,
  SecretaryTriggerServerState,
  SecretaryTriggerServerStatus,
  SecretaryTriggerView,
  SecretaryUpdate,
} from '@shared/types/secretary';
import { redactSecrets } from '../../memory/distill';
import type { SecureCodec } from '../../secureFile';
import { enqueueUpdate } from '../results';
import { SecretaryStore } from '../store';
import {
  createTriggerServer,
  type LocalTriggerServer,
  type TriggerAuthResult,
  type TriggerDispatchResult,
} from './server';
import { TriggerServerConfigStore, TriggerStore } from './store';

const RATE_WINDOW_MS = 10_000;
const RATE_MAX_EVENTS = 20;
const DEDUP_MAX_ENTRIES = 500;

export interface TriggerSecretaryRef {
  id: string;
  dir: string;
}

export interface TriggerManagerDeps {
  rootDir(): string;
  enabled(): boolean;
  secretaries(): readonly TriggerSecretaryRef[];
  secretary(secretaryId: string): TriggerSecretaryRef | null;
  onEnqueued(secretaryId: string, deliverAt?: number): void;
  onChanged(): void;
  audit?(secretaryDir: string, entry: SecretaryAuditEntry): void;
  now?: () => number;
  codec?: SecureCodec;
}

function tokensMatch(expected: string, actual: string): boolean {
  if (!expected || !actual) return false;
  const a = Buffer.from(expected, 'utf-8');
  const b = Buffer.from(actual, 'utf-8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function newTriggerId(): string {
  return `trg-${randomBytes(6).toString('hex')}`;
}

function newTriggerToken(): string {
  return randomBytes(32).toString('hex');
}

function sanitizeHeaderValue(value: string): string {
  return value.replace(/[\r\n"[\]]/gu, ' ').trim();
}

/**
 * 所有秘书共用的本机触发器管理器：
 * - 按秘书存 triggers.json 与加密 trigger-tokens.bin
 * - 按需起停 127.0.0.1 HTTP+WS 服务端（只在秘书开启且至少有 1 条启用触发器时监听）
 * - 统一做 token 恒定时间校验、滑窗限速、eventId 幂等去重、写入 outbox 并唤醒目标秘书
 */
export class TriggerManager {
  private readonly now: () => number;
  private readonly stores = new Map<string, TriggerStore>();
  private readonly rateHits = new Map<string, number[]>();
  private readonly recentEventIds = new Map<string, string[]>();
  private readonly server: LocalTriggerServer;
  private status: SecretaryTriggerServerStatus = 'stopped';
  private serverError: string | undefined;
  private syncing: Promise<void> = Promise.resolve();

  constructor(private readonly deps: TriggerManagerDeps) {
    this.now = deps.now ?? Date.now;
    this.server = createTriggerServer({
      authenticate: (triggerId, token) => this.authenticate(triggerId, token),
      dispatch: (triggerId, token, event) => this.dispatch(triggerId, token, event),
    });
  }

  private configStore(): TriggerServerConfigStore {
    return new TriggerServerConfigStore(this.deps.rootDir());
  }

  private storeOf(ref: TriggerSecretaryRef): TriggerStore {
    let store = this.stores.get(ref.id);
    if (!store) {
      store = new TriggerStore(ref.dir, this.deps.codec);
      this.stores.set(ref.id, store);
    }
    return store;
  }

  private async hydrateAll(): Promise<void> {
    await Promise.all(this.deps.secretaries().map((ref) => this.storeOf(ref).ready()));
  }

  private findTrigger(triggerId: string): {
    ref: TriggerSecretaryRef;
    store: TriggerStore;
    trigger: SecretaryTrigger;
  } | null {
    for (const ref of this.deps.secretaries()) {
      const store = this.storeOf(ref);
      const trigger = store.list().find((item) => item.id === triggerId);
      if (trigger) return { ref, store, trigger };
    }
    return null;
  }

  private countActiveTriggers(): number {
    let total = 0;
    for (const ref of this.deps.secretaries()) {
      for (const trigger of this.storeOf(ref).list()) {
        if (trigger.enabled) total += 1;
      }
    }
    return total;
  }

  private viewOf(trigger: SecretaryTrigger, port: number): SecretaryTriggerView {
    return {
      ...trigger,
      ...buildTriggerUrls(port, trigger.id),
    };
  }

  serverState(): SecretaryTriggerServerState {
    const config = this.configStore().readConfig();
    const actualPort = this.server.port();
    return {
      host: '127.0.0.1',
      port: actualPort ?? config.port,
      configuredPort: config.port,
      status: this.status,
      ...(this.serverError ? { error: this.serverError } : {}),
      activeCount: this.countActiveTriggers(),
    };
  }

  async start(): Promise<void> {
    await this.hydrateAll();
    await this.syncServer();
  }

  async stop(): Promise<void> {
    const run = this.syncing.then(async () => {
      await this.server.stop();
      this.configStore().clearRuntime();
      this.status = 'stopped';
      this.serverError = undefined;
    });
    this.syncing = run.catch(() => {});
    await run;
  }

  async syncServer(forceRestart = false): Promise<void> {
    const run = this.syncing.then(async () => {
      await this.hydrateAll();
      const shouldRun = this.deps.enabled() && this.countActiveTriggers() > 0;
      const configuredPort = this.configStore().readConfig().port;
      if (!shouldRun) {
        if (this.server.running() || this.status !== 'stopped') {
          await this.server.stop();
          this.configStore().clearRuntime();
          this.status = 'stopped';
          this.serverError = undefined;
          this.deps.onChanged();
        }
        return;
      }
      if (
        this.server.running() &&
        !forceRestart &&
        (configuredPort === 0 || this.server.port() === configuredPort)
      ) {
        return;
      }
      if (this.server.running()) {
        await this.server.stop();
        this.configStore().clearRuntime();
      }
      try {
        const listened = await this.server.start(configuredPort);
        this.status = 'listening';
        this.serverError = undefined;
        this.configStore().writeRuntime({
          pid: process.pid,
          host: '127.0.0.1',
          port: listened,
          startedAt: this.now(),
        });
      } catch (error) {
        this.status = 'error';
        this.serverError = error instanceof Error ? error.message : String(error);
        this.configStore().clearRuntime();
      }
      this.deps.onChanged();
    });
    this.syncing = run.catch(() => {});
    await run;
  }

  async list(secretaryId: string): Promise<{
    server: SecretaryTriggerServerState;
    triggers: SecretaryTriggerView[];
  }> {
    const ref = this.deps.secretary(secretaryId);
    const server = this.serverState();
    if (!ref) return { server, triggers: [] };
    const store = this.storeOf(ref);
    await store.ready();
    const port = server.port;
    return {
      server,
      triggers: store.list().map((trigger) => this.viewOf(trigger, port)),
    };
  }

  async create(
    secretaryId: string,
    raw: unknown
  ): Promise<
    | {
        ok: true;
        trigger: SecretaryTriggerView;
        token: string;
        server: SecretaryTriggerServerState;
      }
    | { ok: false; error: string }
  > {
    const ref = this.deps.secretary(secretaryId);
    if (!ref) return { ok: false, error: 'secretary-not-found' };
    const parsed = parseTriggerCreateDraft(raw);
    if (!parsed.ok) return parsed;
    const store = this.storeOf(ref);
    await store.ready();
    const current = store.list();
    if (current.length >= MAX_TRIGGERS_PER_SECRETARY) return { ok: false, error: 'limit' };
    const now = this.now();
    const id = newTriggerId();
    const token = newTriggerToken();
    const created: SecretaryTrigger = {
      id,
      name: parsed.draft.name,
      enabled: parsed.draft.enabled,
      coalesceMs: parsed.draft.coalesceMs,
      createdAt: now,
      updatedAt: now,
      fireCount: 0,
      ...(parsed.draft.instruction ? { instruction: parsed.draft.instruction } : {}),
      ...(parsed.draft.secretaryConversationId
        ? { secretaryConversationId: parsed.draft.secretaryConversationId }
        : {}),
    };
    await store.setToken(id, token);
    store.saveList([...current, created]);
    this.deps.audit?.(ref.dir, {
      at: now,
      secretaryConversationId: null,
      op: 'trigger_create',
      targetId: id,
      ok: true,
      detail: created.name,
    });
    await this.syncServer();
    const server = this.serverState();
    this.deps.onChanged();
    return { ok: true, trigger: this.viewOf(created, server.port), token, server };
  }

  async update(
    secretaryId: string,
    triggerId: string,
    raw: unknown
  ): Promise<
    | { ok: true; trigger: SecretaryTriggerView; server: SecretaryTriggerServerState }
    | { ok: false; error: string }
  > {
    const ref = this.deps.secretary(secretaryId);
    if (!ref) return { ok: false, error: 'secretary-not-found' };
    const parsed = parseTriggerUpdateDraft(raw);
    if (!parsed.ok) return parsed;
    const store = this.storeOf(ref);
    await store.ready();
    const current = store.list();
    const index = current.findIndex((item) => item.id === triggerId);
    if (index < 0) return { ok: false, error: 'not-found' };
    const existing = current[index];
    const now = this.now();
    const updated: SecretaryTrigger = {
      ...existing,
      ...(parsed.patch.name !== undefined ? { name: parsed.patch.name } : {}),
      ...(parsed.patch.enabled !== undefined ? { enabled: parsed.patch.enabled } : {}),
      ...(parsed.patch.coalesceMs !== undefined ? { coalesceMs: parsed.patch.coalesceMs } : {}),
      updatedAt: now,
    };
    if (parsed.patch.instruction === null) delete updated.instruction;
    else if (parsed.patch.instruction !== undefined) updated.instruction = parsed.patch.instruction;
    if (parsed.patch.secretaryConversationId === null) delete updated.secretaryConversationId;
    else if (parsed.patch.secretaryConversationId !== undefined)
      updated.secretaryConversationId = parsed.patch.secretaryConversationId;
    const next = [...current];
    next[index] = updated;
    store.saveList(next);
    this.deps.audit?.(ref.dir, {
      at: now,
      secretaryConversationId: null,
      op: 'trigger_update',
      targetId: triggerId,
      ok: true,
      detail: `enabled=${updated.enabled} coalesceMs=${updated.coalesceMs}`,
    });
    await this.syncServer();
    const server = this.serverState();
    this.deps.onChanged();
    return { ok: true, trigger: this.viewOf(updated, server.port), server };
  }

  async remove(
    secretaryId: string,
    triggerId: string
  ): Promise<{ ok: true; server: SecretaryTriggerServerState } | { ok: false; error: string }> {
    const ref = this.deps.secretary(secretaryId);
    if (!ref) return { ok: false, error: 'secretary-not-found' };
    const store = this.storeOf(ref);
    await store.ready();
    const current = store.list();
    const next = current.filter((item) => item.id !== triggerId);
    if (next.length === current.length) return { ok: false, error: 'not-found' };
    store.saveList(next);
    await store.deleteToken(triggerId);
    this.rateHits.delete(triggerId);
    this.recentEventIds.delete(triggerId);
    this.deps.audit?.(ref.dir, {
      at: this.now(),
      secretaryConversationId: null,
      op: 'trigger_remove',
      targetId: triggerId,
      ok: true,
    });
    await this.syncServer();
    const server = this.serverState();
    this.deps.onChanged();
    return { ok: true, server };
  }

  async rotateToken(
    secretaryId: string,
    triggerId: string
  ): Promise<{ ok: true; token: string } | { ok: false; error: string }> {
    const ref = this.deps.secretary(secretaryId);
    if (!ref) return { ok: false, error: 'secretary-not-found' };
    const store = this.storeOf(ref);
    await store.ready();
    if (!store.list().some((item) => item.id === triggerId))
      return { ok: false, error: 'not-found' };
    const token = newTriggerToken();
    await store.setToken(triggerId, token);
    this.deps.audit?.(ref.dir, {
      at: this.now(),
      secretaryConversationId: null,
      op: 'trigger_rotate_token',
      targetId: triggerId,
      ok: true,
    });
    return { ok: true, token };
  }

  async revealToken(
    secretaryId: string,
    triggerId: string
  ): Promise<{ ok: true; token: string } | { ok: false; error: string }> {
    const ref = this.deps.secretary(secretaryId);
    if (!ref) return { ok: false, error: 'secretary-not-found' };
    const store = this.storeOf(ref);
    await store.ready();
    if (!store.list().some((item) => item.id === triggerId))
      return { ok: false, error: 'not-found' };
    const token = store.getToken(triggerId);
    if (!token) return { ok: false, error: 'token-missing' };
    return { ok: true, token };
  }

  async setPort(
    port: unknown
  ): Promise<{ ok: true; server: SecretaryTriggerServerState } | { ok: false; error: string }> {
    const validated = parseTriggerPort(port);
    if (validated === null) return { ok: false, error: 'invalid-port' };
    this.configStore().savePort(validated);
    await this.syncServer(true);
    const server = this.serverState();
    this.deps.onChanged();
    return { ok: true, server };
  }

  async testFire(
    secretaryId: string,
    triggerId: string,
    text?: string
  ): Promise<{ ok: true; deliveryKey: string } | { ok: false; error: string }> {
    const ref = this.deps.secretary(secretaryId);
    if (!ref) return { ok: false, error: 'secretary-not-found' };
    const store = this.storeOf(ref);
    await store.ready();
    const trigger = store.list().find((item) => item.id === triggerId);
    if (!trigger) return { ok: false, error: 'not-found' };
    const res = this.enqueueEvent(
      ref,
      store,
      trigger,
      {
        source: 'manual-test',
        payload: text?.trim() || '这是一条来自设置页的测试触发事件，收到后简要确认即可。',
      },
      { immediate: true }
    );
    if (!res.ok) return res;
    return { ok: true, deliveryKey: res.deliveryKey };
  }

  async onSecretaryRemoved(secretaryId: string): Promise<void> {
    this.stores.delete(secretaryId);
    await this.syncServer();
  }

  private authenticate(triggerId: string, token: string): TriggerAuthResult {
    const found = this.findTrigger(triggerId);
    if (!found) return { ok: false, error: 'not-found' };
    const expected = found.store.getToken(triggerId) ?? '';
    if (!tokensMatch(expected, token)) return { ok: false, error: 'unauthorized' };
    if (!found.trigger.enabled) return { ok: false, error: 'disabled' };
    return { ok: true };
  }

  private checkRateLimit(triggerId: string, now: number): boolean {
    const hits = (this.rateHits.get(triggerId) ?? []).filter((ts) => now - ts < RATE_WINDOW_MS);
    if (hits.length >= RATE_MAX_EVENTS) {
      this.rateHits.set(triggerId, hits);
      return false;
    }
    hits.push(now);
    this.rateHits.set(triggerId, hits);
    return true;
  }

  private seenEventId(triggerId: string, eventId: string): boolean {
    const list = this.recentEventIds.get(triggerId);
    return list ? list.includes(eventId) : false;
  }

  private rememberEventId(triggerId: string, eventId: string): void {
    const list = this.recentEventIds.get(triggerId) ?? [];
    list.push(eventId);
    if (list.length > DEDUP_MAX_ENTRIES) list.splice(0, list.length - DEDUP_MAX_ENTRIES);
    this.recentEventIds.set(triggerId, list);
  }

  private dispatch(
    triggerId: string,
    token: string,
    event: TriggerInboundEvent
  ): TriggerDispatchResult {
    if (!this.deps.enabled()) return { ok: false, error: 'secretary-disabled' };
    const auth = this.authenticate(triggerId, token);
    if (!auth.ok) return auth;
    const found = this.findTrigger(triggerId);
    if (!found) return { ok: false, error: 'not-found' };
    const now = this.now();
    if (!this.checkRateLimit(triggerId, now)) {
      this.deps.audit?.(found.ref.dir, {
        at: now,
        secretaryConversationId: found.trigger.secretaryConversationId ?? null,
        op: 'trigger_rate_limited',
        targetId: triggerId,
        ok: false,
      });
      return { ok: false, error: 'rate-limited' };
    }
    return this.enqueueEvent(found.ref, found.store, found.trigger, event);
  }

  private enqueueEvent(
    ref: TriggerSecretaryRef,
    store: TriggerStore,
    trigger: SecretaryTrigger,
    event: TriggerInboundEvent,
    options?: { immediate?: boolean }
  ): TriggerDispatchResult {
    const now = this.now();
    const deliveryKey = event.eventId
      ? `trigger:${trigger.id}:${event.eventId}`
      : `trigger:${trigger.id}:${now}:${randomBytes(4).toString('hex')}`;

    const secretaryStore = new SecretaryStore(ref.dir, this.now);
    const dispatchFile = secretaryStore.dispatch();
    if (
      event.eventId &&
      (this.seenEventId(trigger.id, event.eventId) ||
        dispatchFile.outbox.some((entry) => entry.key === deliveryKey))
    ) {
      return { ok: true, deliveryKey, deduplicated: true };
    }

    // 同一触发器已有未投递事件在等合并窗口时，沿用其较早的 deliverAt 避免连续来消息饿死
    let deliverAt: number | undefined;
    if (!options?.immediate && trigger.coalesceMs > 0) {
      const existingDue = dispatchFile.outbox
        .filter(
          (entry) =>
            entry.kind === 'trigger' &&
            entry.triggerId === trigger.id &&
            entry.deliverAt !== undefined
        )
        .map((entry) => entry.deliverAt as number);
      deliverAt = existingDue.length > 0 ? Math.min(...existingDue) : now + trigger.coalesceMs;
    }

    const update: SecretaryUpdate = {
      key: deliveryKey,
      at: event.at ?? now,
      kind: 'trigger',
      triggerId: trigger.id,
      triggerName: sanitizeHeaderValue(trigger.name) || trigger.id,
      text: `${trigger.name}${event.source ? ` · ${event.source}` : ''}`,
      payload: redactSecrets(event.payload),
      ...(trigger.instruction ? { instruction: trigger.instruction } : {}),
      ...(event.source ? { source: sanitizeHeaderValue(event.source) } : {}),
      ...(trigger.secretaryConversationId
        ? { secretaryConversationId: trigger.secretaryConversationId }
        : {}),
      ...(deliverAt !== undefined ? { deliverAt } : {}),
    };

    dispatchFile.outbox = enqueueUpdate(dispatchFile.outbox, update);
    secretaryStore.saveDispatch(dispatchFile);

    if (event.eventId) this.rememberEventId(trigger.id, event.eventId);

    // 更新触发计数与最近触发时间
    const list = store.list();
    const updatedList = list.map((item) =>
      item.id === trigger.id ? { ...item, lastFiredAt: now, fireCount: item.fireCount + 1 } : item
    );
    store.saveList(updatedList);

    this.deps.audit?.(ref.dir, {
      at: now,
      secretaryConversationId: trigger.secretaryConversationId ?? null,
      op: 'trigger_fired',
      targetId: trigger.id,
      ok: true,
      detail: [
        event.source ? `source=${event.source}` : '',
        event.eventId ? `eventId=${event.eventId}` : '',
      ]
        .filter(Boolean)
        .join(' '),
    });

    this.deps.onEnqueued(ref.id, deliverAt);
    this.deps.onChanged();
    return { ok: true, deliveryKey, deduplicated: false };
  }
}
