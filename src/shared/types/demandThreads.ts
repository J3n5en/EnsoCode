import type { PluginInjectSender } from '../extensionPlugins/protocol';

export const DEMAND_THREAD_STATUSES = [
  'open',
  'in_progress',
  'pr_opened',
  'ci_failed',
  'needs_human',
  'merged',
  'closed',
] as const;
export type DemandThreadStatus = (typeof DEMAND_THREAD_STATUSES)[number];

export const DEMAND_MILESTONE_KINDS = ['pr_opened', 'ci_failed', 'needs_human', 'merged'] as const;
export type DemandMilestoneKind = (typeof DEMAND_MILESTONE_KINDS)[number];

export const DEMAND_PR_EVENT_KINDS = [
  'pr_opened',
  'comment',
  'review',
  'ci_failed',
  'ci_passed',
  'needs_human',
  'merged',
  'closed',
] as const;
export type DemandPrEventKind = (typeof DEMAND_PR_EVENT_KINDS)[number];

export interface DemandThreadSource {
  channel: string;
  chatId: string;
  messageId: string;
  topicId?: string;
  senderId?: string;
  senderName?: string;
  summary?: string;
}

export interface DemandThreadPr {
  repo: string;
  number: number;
  url?: string;
  title?: string;
  headSha?: string;
}

export interface DemandMilestoneRecord {
  kind: DemandMilestoneKind;
  dedupeKey?: string;
  sentAt: number;
  summary?: string;
  replyMessageId?: string;
}

export interface DemandThreadRecord {
  id: string;
  source: DemandThreadSource;
  requesterIsOwner: boolean;
  sessionId: string;
  pluginId?: string;
  subagentId?: string;
  secretaryId?: string;
  pr?: DemandThreadPr;
  status: DemandThreadStatus;
  milestonesSent: DemandMilestoneRecord[];
  createdAt: number;
  updatedAt: number;
  completedAt?: number;
}

export type DemandThreadView = DemandThreadRecord;

export interface DemandPrEventInput {
  repo: string;
  number: number;
  kind: DemandPrEventKind;
  text: string;
  url?: string;
  title?: string;
  headSha?: string;
  summary?: string;
  sender?: PluginInjectSender;
}

export type DemandPrRouteResult =
  | { routed: false; reason: 'no-thread' }
  | {
      routed: true;
      threadId: string;
      sessionId: string;
      delivered: boolean;
      milestonePushed: boolean;
      milestoneKind?: DemandMilestoneKind;
      replyMessageId?: string;
      error?: string;
    };

const CHANNEL = /^[a-z0-9._:-]{1,64}$/;
const ID = /^.{1,128}$/;
const REPO = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;

export function demandSourceKey(source: {
  channel: string;
  chatId: string;
  messageId: string;
}): string {
  return `${source.channel}:${source.chatId}:${source.messageId}`;
}

export function demandPrKey(repo: string, number: number): string {
  return `${repo.toLowerCase()}#${number}`;
}

export function demandPrClaimKey(repo: string, number: number, kind?: string): string {
  return `github:${repo.toLowerCase()}#${number}:${kind ?? 'event'}`;
}

export function parseClaimKeyTarget(
  key: string
):
  | { kind: 'pr'; repo: string; number: number }
  | { kind: 'tg'; chatId: string; messageId: string }
  | null {
  const pr = /^github:([^#]+)#(\d+)(?::.*)?$/.exec(key);
  if (pr?.[1] && pr[2] && REPO.test(pr[1])) {
    return { kind: 'pr', repo: pr[1], number: Number(pr[2]) };
  }
  const tg = /^tg:(.+):([^:]+)$/.exec(key);
  if (!tg?.[1] || !tg[2] || tg[1].length > 128 || tg[2].length > 128) return null;
  if (key.startsWith('github:')) return null;
  return { kind: 'tg', chatId: tg[1], messageId: tg[2] };
}

export function isGroupMilestoneKind(kind: DemandPrEventKind): kind is DemandMilestoneKind {
  return (DEMAND_MILESTONE_KINDS as readonly string[]).includes(kind);
}

function text(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > max) return null;
  return trimmed;
}

function optionalText(value: unknown, max: number): string | undefined | null {
  if (value === undefined) return undefined;
  return text(value, max);
}

export function normalizeDemandChannel(channel: string): string {
  const lower = channel.toLowerCase();
  return lower === 'tg' ? 'telegram' : lower;
}

export function parseDemandSource(raw: unknown): DemandThreadSource | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const v = raw as Record<string, unknown>;
  const channel = text(v.channel, 64);
  const chatId = text(v.chatId, 128);
  const messageId = text(v.messageId, 128);
  if (!channel || !CHANNEL.test(normalizeDemandChannel(channel)) || !chatId || !ID.test(chatId))
    return null;
  if (!messageId || !ID.test(messageId)) return null;
  const topicId = optionalText(v.topicId, 128);
  const senderId = optionalText(v.senderId, 128);
  const senderName = optionalText(v.senderName, 128);
  const summary = optionalText(v.summary, 500);
  if (topicId === null || senderId === null || senderName === null || summary === null) return null;
  return {
    channel: normalizeDemandChannel(channel),
    chatId,
    messageId,
    ...(topicId !== undefined ? { topicId } : {}),
    ...(senderId !== undefined ? { senderId } : {}),
    ...(senderName !== undefined ? { senderName } : {}),
    ...(summary !== undefined ? { summary } : {}),
  };
}

export function parseDemandPr(raw: unknown): DemandThreadPr | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const v = raw as Record<string, unknown>;
  const repo = text(v.repo, 200);
  if (!repo || !REPO.test(repo)) return null;
  if (!Number.isSafeInteger(v.number) || (v.number as number) < 1) return null;
  const url = optionalText(v.url, 500);
  const title = optionalText(v.title, 300);
  const headSha = optionalText(v.headSha, 64);
  if (url === null || title === null || headSha === null) return null;
  return {
    repo,
    number: v.number as number,
    ...(url !== undefined ? { url } : {}),
    ...(title !== undefined ? { title } : {}),
    ...(headSha !== undefined ? { headSha } : {}),
  };
}

export function parseDemandStatus(raw: unknown): DemandThreadStatus | null {
  return typeof raw === 'string' && (DEMAND_THREAD_STATUSES as readonly string[]).includes(raw)
    ? (raw as DemandThreadStatus)
    : null;
}

export function parseDemandPrEvent(raw: unknown): DemandPrEventInput | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const v = raw as Record<string, unknown>;
  const repo = text(v.repo, 200);
  if (!repo || !REPO.test(repo)) return null;
  if (!Number.isSafeInteger(v.number) || (v.number as number) < 1) return null;
  if (typeof v.kind !== 'string' || !(DEMAND_PR_EVENT_KINDS as readonly string[]).includes(v.kind))
    return null;
  const body = text(v.text, 32_000);
  if (!body) return null;
  const url = optionalText(v.url, 500);
  const title = optionalText(v.title, 300);
  const headSha = optionalText(v.headSha, 64);
  const summary = optionalText(v.summary, 500);
  if (url === null || title === null || headSha === null || summary === null) return null;
  let sender: PluginInjectSender | undefined;
  if (v.sender !== undefined) {
    if (typeof v.sender !== 'object' || v.sender === null || Array.isArray(v.sender)) return null;
    const s = v.sender as Record<string, unknown>;
    const channel = text(s.channel, 64);
    if (!channel) return null;
    const chatId = optionalText(s.chatId, 128);
    const userId = optionalText(s.userId, 128);
    const displayName = optionalText(s.displayName, 128);
    if (chatId === null || userId === null || displayName === null) return null;
    sender = {
      channel,
      ...(chatId !== undefined ? { chatId } : {}),
      ...(userId !== undefined ? { userId } : {}),
      ...(displayName !== undefined ? { displayName } : {}),
    };
  }
  return {
    repo,
    number: v.number as number,
    kind: v.kind as DemandPrEventKind,
    text: body,
    ...(url !== undefined ? { url } : {}),
    ...(title !== undefined ? { title } : {}),
    ...(headSha !== undefined ? { headSha } : {}),
    ...(summary !== undefined ? { summary } : {}),
    ...(sender ? { sender } : {}),
  };
}
