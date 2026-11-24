import type { ConversationAuthority, ProjectAuthority } from '@shared/types/agent';
import type { SecretaryDispatchFile, SecretaryUpdate } from '@shared/types/secretary';
import type { HomeConversationResult } from './homeConversation';
import type { SecretarySessionStatus } from './readers';
import {
  BATCH_MAX_CHARS,
  BATCH_MAX_ITEMS,
  dueUpdates,
  formatSessionUpdates,
  takeBatch,
} from './results';

export const RETRY_BASE_MS = 30_000;
export const MAX_ATTEMPTS = 6;
/** status=idle 先于 turn-completed。到点时先等收口，避免把正常结束当成丢事件重投同一条 */
export const DELIVERY_IDLE_GRACE_MS = 2_000;

/** 回传投递用到的 Main 侧能力；全部同步读写，读改写之间不留 await */
export interface DeliveryPorts {
  file(): SecretaryDispatchFile;
  save(file: SecretaryDispatchFile): void;
  rows(): Readonly<Record<string, Record<string, unknown>>>;
  conversations(): readonly ConversationAuthority[];
  projects(): readonly ProjectAuthority[];
  /** projectId → 用户起的别名；缺省按无别名 */
  projectAliases?(): Readonly<Record<string, string>>;
  status(conversationId: string): SecretarySessionStatus;
  alive(conversationId: string): boolean;
  prompt(conversationId: string, text: string, deliveryId: string): { ok: boolean; error?: string };
  resume(conversationId: string): Promise<{ ok: boolean; error?: string }>;
  newId(): string;
  /** 本秘书的隐藏项目：回落只在它的会话里找，不跨秘书；缺省按全部秘书项目 */
  secretaryProjectId?(): string | null;
  /** 还没有会话时建一条：要秘书动手的定时与同事消息不能一直等用户打开它 */
  startConversation?(): Promise<HomeConversationResult>;
}

function retryDelay(attempt: number): number {
  return RETRY_BASE_MS * 2 ** (attempt - 1);
}

function secretaryProjectIds(ports: DeliveryPorts): Set<string> {
  if (ports.secretaryProjectId) {
    const own = ports.secretaryProjectId();
    return new Set(own ? [own] : []);
  }
  return new Set(
    ports
      .projects()
      .filter((project) => project.kind === 'secretary' && project.state === 'active')
      .map((project) => project.projectId)
  );
}

function liveSecretaryConversation(
  ports: DeliveryPorts,
  projectIds: ReadonlySet<string>,
  conversationId: string
): boolean {
  const conversation = ports
    .conversations()
    .find((candidate) => candidate.conversationId === conversationId);
  if (conversation?.kind !== 'root' || !projectIds.has(conversation.projectId)) return false;
  const row = ports.rows()[conversationId];
  return Boolean(row) && row.archived !== true;
}

/** 发起者 → 已归档或删除时取本秘书最近活跃的会话 → 都没有时返回 null（只更新工作台） */
export function resolveTarget(ports: DeliveryPorts, preferred?: string): string | null {
  const projectIds = secretaryProjectIds(ports);
  if (projectIds.size === 0) return null;
  if (preferred && liveSecretaryConversation(ports, projectIds, preferred)) return preferred;
  const rows = ports.rows();
  let latest: { id: string; at: number } | null = null;
  for (const conversation of ports.conversations()) {
    if (conversation.kind !== 'root' || !projectIds.has(conversation.projectId)) continue;
    const row = rows[conversation.conversationId];
    if (!row || row.archived === true) continue;
    const at = typeof row.lastActiveAt === 'number' ? row.lastActiveAt : 0;
    if (!latest || at > latest.at) latest = { id: conversation.conversationId, at };
  }
  return latest?.id ?? null;
}

/** 失败一次：重投时间往后推，次数用完只留在工作台 */
function armRetry(
  ports: DeliveryPorts,
  target: string,
  keys: readonly string[],
  attempt: number,
  now: number
): void {
  const file = ports.file();
  if (attempt >= MAX_ATTEMPTS) {
    file.outbox = file.outbox.filter((update) => !keys.includes(update.key));
    delete file.inflight;
    ports.save(file);
    return;
  }
  file.inflight = {
    deliveryId: file.inflight?.deliveryId ?? ports.newId(),
    secretaryConversationId: target,
    keys: [...keys],
    attempt: attempt + 1,
    nextAttemptAt: now + retryDelay(attempt),
  };
  ports.save(file);
}

export type DeliveryOutcome = 'started' | 'done' | 'failed';

/** 结算在途批次：上屏了记下开始，投递那一轮正常结束才算成功 */
export function settleDelivery(
  ports: DeliveryPorts,
  conversationId: string,
  outcome: DeliveryOutcome,
  now: number
): void {
  const inflight = ports.file().inflight;
  if (!inflight || inflight.secretaryConversationId !== conversationId) return;
  if (outcome === 'started') {
    const file = ports.file();
    file.inflight = { ...inflight, started: true };
    ports.save(file);
    return;
  }
  if (outcome === 'failed') {
    armRetry(ports, inflight.secretaryConversationId, inflight.keys, inflight.attempt, now);
    return;
  }
  const file = ports.file();
  file.outbox = file.outbox.filter((update) => !inflight.keys.includes(update.key));
  delete file.inflight;
  ports.save(file);
}

/** 启动时：已经开始的投递等它结束，没开始的按原批次重发 */
export function recoverDeliveries(ports: DeliveryPorts, now: number): void {
  const file = ports.file();
  const inflight = file.inflight;
  if (!inflight) return;
  if (ports.status(inflight.secretaryConversationId).state !== 'idle') {
    file.inflight = { ...inflight, nextAttemptAt: now + retryDelay(inflight.attempt) };
    ports.save(file);
    return;
  }
  delete file.inflight;
  ports.save(file);
}

interface Group {
  target: string;
  updates: SecretaryUpdate[];
}

/** 要秘书动手的更新；结果回传没有会话时只更新工作台 */
const WAKES_SECRETARY: ReadonlySet<string> = new Set(['schedule', 'peer-message']);

function dueKeys(ports: DeliveryPorts, now: number): Set<string> {
  const file = ports.file();
  const inflightKeys = new Set(file.inflight?.keys ?? []);
  return new Set(
    dueUpdates(
      file.outbox.filter((update) => !inflightKeys.has(update.key)),
      now
    ).map((update) => update.key)
  );
}

function needsNewConversation(ports: DeliveryPorts, now: number): boolean {
  const due = dueKeys(ports, now);
  return ports
    .file()
    .outbox.some(
      (update) =>
        due.has(update.key) &&
        WAKES_SECRETARY.has(update.kind) &&
        !resolveTarget(ports, update.secretaryConversationId)
    );
}

function planGroups(ports: DeliveryPorts, now: number): Group[] {
  const file = ports.file();
  const due = dueKeys(ports, now);
  const groups = new Map<string, SecretaryUpdate[]>();
  for (const update of file.outbox) {
    if (!due.has(update.key)) continue;
    const target = resolveTarget(ports, update.secretaryConversationId);
    if (!target) continue;
    const list = groups.get(target);
    if (list) list.push(update);
    else groups.set(target, [update]);
  }
  return [...groups].map(([target, updates]) => ({ target, updates }));
}

/**
 * 目标空闲时把一批结果注入秘书会话。一次只投一批：在途批次没结算前不叠加，
 * 否则秘书那边会同时收到两条互相矛盾的进展。
 */
export function flushDeliveries(ports: DeliveryPorts, now: number): Promise<void> {
  // 恢复 worker 要 await：期间再来的事件与定时器不能各自再注入同一批
  const running = flushing.get(ports);
  if (running) return running;
  const flush = flushOnce(ports, now).finally(() => flushing.delete(ports));
  flushing.set(ports, flush);
  return flush;
}

const flushing = new WeakMap<DeliveryPorts, Promise<void>>();

async function flushOnce(ports: DeliveryPorts, now: number): Promise<void> {
  let attempt = 1;
  const pending = ports.file().inflight;
  if (pending) {
    if (now < pending.nextAttemptAt) return;
    if (ports.status(pending.secretaryConversationId).state !== 'idle') {
      // 秘书还在跑上一批：只把看门狗往后推，不算一次失败
      const file = ports.file();
      if (file.inflight) {
        file.inflight = {
          ...file.inflight,
          nextAttemptAt: now + retryDelay(file.inflight.attempt),
        };
        ports.save(file);
      }
      return;
    }
    // 会话还活着才可能有紧跟着的 turn-completed。worker 已经不在就不必等
    if (pending.idleGraceUntil === undefined && ports.alive(pending.secretaryConversationId)) {
      const file = ports.file();
      if (file.inflight) {
        file.inflight = { ...file.inflight, idleGraceUntil: now + DELIVERY_IDLE_GRACE_MS };
        ports.save(file);
      }
      return;
    }
    if (pending.idleGraceUntil !== undefined && now < pending.idleGraceUntil) return;
    // 轮次结束事件丢了（重启等）：批次还在 outbox 里，按原次数重投
    attempt = pending.attempt;
    const file = ports.file();
    delete file.inflight;
    ports.save(file);
  }

  if (ports.startConversation && needsNewConversation(ports, now)) {
    const started = await ports.startConversation();
    if (!started.ok) return;
  }

  for (const group of planGroups(ports, now)) {
    if (ports.status(group.target).state !== 'idle') continue;
    const batch = takeBatch(group.updates, {
      max: BATCH_MAX_ITEMS,
      maxChars: BATCH_MAX_CHARS,
    });
    if (batch.length === 0) continue;
    const keys = batch.map((update) => update.key);
    if (!ports.alive(group.target)) {
      const resumed = await ports.resume(group.target);
      if (!resumed.ok) {
        armRetry(ports, group.target, keys, attempt, now);
        return;
      }
    }
    const deliveryId = ports.newId();
    const result = ports.prompt(group.target, formatSessionUpdates(batch), deliveryId);
    if (!result.ok) {
      armRetry(ports, group.target, keys, attempt, now);
      return;
    }
    const file = ports.file();
    file.inflight = {
      deliveryId,
      secretaryConversationId: group.target,
      keys,
      attempt,
      nextAttemptAt: now + retryDelay(attempt),
    };
    ports.save(file);
    return;
  }
}
