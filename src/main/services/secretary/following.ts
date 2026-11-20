import { join } from 'node:path';
import type {
  SecretaryAuditEntry,
  SecretaryFollowingView,
  SecretaryFollowKind,
} from '@shared/types/secretary';
import { readJson, writeJsonAtomic } from '../bots/files';
import { appendAudit } from './audit';
import type { Peer } from './contact/channel';

/** 手机关注的任务上限：超过按时间淘汰最旧的 */
export const FOLLOWING_LIMIT = 20;

/** 摘要只留一句话：推送时它只是「你让我做的哪件事」的标签 */
const SUMMARY_MAX = 80;

/**
 * 一条关注：手机发起的回合里派生出来的会话或定时。
 * 记下发起它的联系人与摘要，之后的结果推送即使 /sync 关着也能对上是哪件事。
 */
export interface FollowedTask {
  /** kind:targetId，去重与取消都认它 */
  id: string;
  kind: SecretaryFollowKind;
  /** 会话 id 或定时 id；等待中的派发先记 pendingId，建出会话后改挂 */
  targetId: string;
  /** 结果只回发起它的那个联系人 */
  origin: Peer;
  at: number;
  summary: string;
  secretaryConversationId?: string;
}

export interface FollowingFile {
  version: 1;
  items: FollowedTask[];
}

/** 联系方式服务只用这几个动作；生产实现是下面的 FollowingStore */
export interface FollowingPort {
  list(): FollowedTask[];
  find(kind: SecretaryFollowKind, targetId: string): FollowedTask | undefined;
  /** 推送过一次就结束关注 */
  take(kind: SecretaryFollowKind, targetId: string): FollowedTask | undefined;
  remove(id: string): boolean;
  clear(): number;
  /** 渠道解绑或插件停用：只清这个渠道发起的关注 */
  clearChannel(channelId: string): number;
}

export function followKey(kind: SecretaryFollowKind, targetId: string): string {
  return `${kind}:${targetId}`;
}

export function emptyFollowingFile(): FollowingFile {
  return { version: 1, items: [] };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isKind(value: unknown): value is SecretaryFollowKind {
  return value === 'session' || value === 'schedule';
}

function summaryOf(value: unknown): string {
  if (typeof value !== 'string') return '';
  const flat = value.replace(/\s+/gu, ' ').trim();
  return flat.length > SUMMARY_MAX ? `${flat.slice(0, SUMMARY_MAX)}…` : flat;
}

/** 老数据只有 Telegram 的 chatId：升级成 { channelId:'telegram', peerId } */
function parseOrigin(raw: Record<string, unknown>): Peer {
  const origin = raw.origin;
  if (
    isRecord(origin) &&
    typeof origin.channelId === 'string' &&
    origin.channelId &&
    typeof origin.peerId === 'string'
  ) {
    return {
      channelId: origin.channelId,
      peerId: origin.peerId,
      ...(typeof origin.topicId === 'string' && origin.topicId ? { topicId: origin.topicId } : {}),
    };
  }
  const chatId = typeof raw.chatId === 'number' && Number.isInteger(raw.chatId) ? raw.chatId : 0;
  return { channelId: 'telegram', peerId: String(chatId) };
}

function parseItem(raw: unknown): FollowedTask | null {
  if (!isRecord(raw)) return null;
  const kind = raw.kind;
  const targetId = typeof raw.targetId === 'string' ? raw.targetId.trim() : '';
  const at = typeof raw.at === 'number' && Number.isFinite(raw.at) ? raw.at : 0;
  if (!isKind(kind) || !targetId) return null;
  return {
    id: followKey(kind, targetId),
    kind,
    targetId,
    origin: parseOrigin(raw),
    at,
    summary: summaryOf(raw.summary),
    ...(typeof raw.secretaryConversationId === 'string' && raw.secretaryConversationId
      ? { secretaryConversationId: raw.secretaryConversationId }
      : {}),
  };
}

/** 坏条目一律跳过：关注列表读不出来的那一条不该顶掉整张列表 */
export function parseFollowingFile(raw: unknown): FollowingFile {
  if (!isRecord(raw) || !Array.isArray(raw.items)) return emptyFollowingFile();
  const items: FollowedTask[] = [];
  const seen = new Set<string>();
  for (const value of raw.items) {
    const item = parseItem(value);
    if (!item || seen.has(item.id)) continue;
    seen.add(item.id);
    items.push(item);
  }
  return { version: 1, items: items.slice(-FOLLOWING_LIMIT) };
}

/** userData/secretary/following.json：只放手机关注的任务，重启后接着跟 */
export class FollowingStore implements FollowingPort {
  constructor(private readonly dir: string) {}

  file(): FollowingFile {
    return parseFollowingFile(readJson(join(this.dir, 'following.json')));
  }

  list(): FollowedTask[] {
    return this.file().items;
  }

  save(items: readonly FollowedTask[]): FollowingFile {
    // 按时间排：淘汰最旧的与列表展示都认这个顺序
    const sorted = [...items].sort((left, right) => left.at - right.at);
    const parsed = parseFollowingFile({ version: 1, items: sorted });
    writeJsonAtomic(join(this.dir, 'following.json'), parsed);
    return parsed;
  }

  /** 同一个目标只留一条：再记一次就是刷新时间与摘要 */
  add(input: {
    kind: SecretaryFollowKind;
    targetId: string;
    origin: Peer;
    at: number;
    summary: string;
    secretaryConversationId?: string;
  }): FollowedTask {
    const item: FollowedTask = {
      id: followKey(input.kind, input.targetId),
      kind: input.kind,
      targetId: input.targetId,
      origin: {
        channelId: input.origin.channelId,
        peerId: input.origin.peerId,
        ...(input.origin.topicId ? { topicId: input.origin.topicId } : {}),
      },
      at: input.at,
      summary: summaryOf(input.summary),
      ...(input.secretaryConversationId
        ? { secretaryConversationId: input.secretaryConversationId }
        : {}),
    };
    const rest = this.list().filter((entry) => entry.id !== item.id);
    // 超上限淘汰最旧的：先按时间，时间相同按原顺序
    this.save([...rest, item].slice(-FOLLOWING_LIMIT));
    return item;
  }

  find(kind: SecretaryFollowKind, targetId: string): FollowedTask | undefined {
    const id = followKey(kind, targetId);
    return this.list().find((entry) => entry.id === id);
  }

  take(kind: SecretaryFollowKind, targetId: string): FollowedTask | undefined {
    const found = this.find(kind, targetId);
    if (!found) return undefined;
    this.remove(found.id);
    return found;
  }

  remove(id: string): boolean {
    const items = this.list();
    const rest = items.filter((entry) => entry.id !== id);
    if (rest.length === items.length) return false;
    this.save(rest);
    return true;
  }

  clear(): number {
    const count = this.list().length;
    if (count > 0) this.save([]);
    return count;
  }

  clearChannel(channelId: string): number {
    const items = this.list();
    const rest = items.filter((entry) => entry.origin.channelId !== channelId);
    if (rest.length !== items.length) this.save(rest);
    return items.length - rest.length;
  }

  /** 等待中的派发/待确认的卡变成真实会话：关注项改挂到会话上 */
  renameTarget(from: string, to: string): boolean {
    const items = this.list();
    const item = items.find((entry) => entry.targetId === from);
    if (!item || from === to) return false;
    const next: FollowedTask = { ...item, targetId: to, id: followKey(item.kind, to) };
    this.save([...items.filter((entry) => entry !== item && entry.id !== next.id), next]);
    return true;
  }
}

/** 界面与手机命令共用的一份视图：不带 origin 这类内部字段 */
export function followingViews(items: readonly FollowedTask[]): SecretaryFollowingView[] {
  return items.map((item) => ({
    id: item.id,
    kind: item.kind,
    summary: item.summary,
    at: item.at,
  }));
}

/**
 * 手机发起的回合：由联系方式服务登记，返回发起它的联系人。
 * 派发与定时都不认识联系方式，只通过这个探针问一句「这一轮是手机发起的吗」。
 */
let phoneTurnChat: ((conversationId: string) => Peer | null) | null = null;

export function setPhoneTurnChatProbe(
  probe: ((conversationId: string) => Peer | null) | null
): void {
  phoneTurnChat = probe;
}

export function phoneTurnChatOf(conversationId: string | null): Peer | null {
  if (!conversationId) return null;
  try {
    return phoneTurnChat?.(conversationId) ?? null;
  } catch {
    return null;
  }
}

/** 写关注要的三件事：存储、探针与审计；测试整份换掉，生产走该秘书的目录 */
export interface FollowDeps {
  store: FollowingStore;
  probe(conversationId: string | null): Peer | null;
  audit(entry: SecretaryAuditEntry): void;
  now(): number;
}

export function followDepsFor(dir: string): FollowDeps {
  return {
    store: new FollowingStore(dir),
    probe: phoneTurnChatOf,
    audit: (entry) => appendAudit(dir, entry),
    now: () => Date.now(),
  };
}

function audit(deps: FollowDeps, op: string, detail?: string, targetId?: string): void {
  deps.audit({
    at: deps.now(),
    secretaryConversationId: null,
    op,
    ok: true,
    ...(targetId ? { targetId } : {}),
    ...(detail ? { detail } : {}),
  });
}

/** 派发与定时写关注都走这里：不是手机发起的回合什么都不做 */
export function recordPhoneFollow(
  input: {
    kind: SecretaryFollowKind;
    targetId: string;
    summary: string;
    secretaryConversationId: string | null;
  },
  deps: FollowDeps
): boolean {
  const origin = deps.probe(input.secretaryConversationId);
  if (origin === null) return false;
  const item = deps.store.add({
    kind: input.kind,
    targetId: input.targetId,
    origin,
    at: deps.now(),
    summary: input.summary,
    ...(input.secretaryConversationId
      ? { secretaryConversationId: input.secretaryConversationId }
      : {}),
  });
  audit(deps, 'contact_follow', `${item.kind} ${item.summary}`, item.targetId);
  return true;
}

/** 等待中的派发/待确认的卡变成真实会话：关注项改挂过去，推送才认得出会话 id */
export function renameFollowedTarget(from: string, to: string, deps: FollowDeps): void {
  if (deps.store.renameTarget(from, to)) audit(deps, 'contact_follow', `relink ${from}`, to);
}

/** 会话被归档、删除或收回接管：关注项一并移除 */
export function unfollowTarget(targetId: string, deps: FollowDeps): void {
  const item = deps.store.list().find((entry) => entry.targetId === targetId);
  if (!item) return;
  deps.store.remove(item.id);
  audit(deps, 'contact_follow_remove', `${item.kind} ${item.summary}`, targetId);
}

/** 会话被归档或删除：不知道它归哪个秘书，各秘书的关注列表都清一遍 */
export async function unfollowTargetEverywhere(targetId: string): Promise<void> {
  const { secretaryContexts } = await import('./secretaries');
  for (const ctx of secretaryContexts()) unfollowTarget(targetId, followDepsFor(ctx.dir));
}
