import { RELAY_ASK_MAX_CHARS } from '@shared/secretary/parse';
import type {
  SecretaryAuditEntry,
  SecretaryDispatchFile,
  SecretaryRelayAsk,
  SecretaryUpdate,
} from '@shared/types/secretary';

/** 转交提问在 dispatch.json 里的键：同一会话可以同时挂几个提问 */
export function relayKey(conversationId: string, askId: string): string {
  return `${conversationId}|${askId}`;
}

export interface RelayPorts {
  file(): SecretaryDispatchFile;
  save(file: SecretaryDispatchFile): void;
  audit?(entry: SecretaryAuditEntry): void;
}

export interface OpenRelayInput {
  conversationId: string;
  askId: string;
  question: string;
  options?: string[];
  defaultOption?: string;
  expiresAt?: number;
  /** 会话的一句话标签（项目 · 标题），只用于回传正文 */
  label: string;
}

export interface CloseRelayInput {
  conversationId: string;
  askId: string;
  by: 'user' | 'relay' | 'timeout';
  answer?: string;
}

function cap(text: string): string {
  return text.length > RELAY_ASK_MAX_CHARS ? `${text.slice(0, RELAY_ASK_MAX_CHARS)}…` : text;
}

function firstLine(text: string): string {
  return (
    text
      .split('\n')
      .map((line) => line.trim())
      .find(Boolean) ?? ''
  );
}

function relayUpdate(
  relay: SecretaryRelayAsk,
  status: SecretaryRelayAsk['status'],
  text: string,
  now: number,
  lastText?: string
): SecretaryUpdate {
  return {
    key: `relay:${relay.conversationId}:${relay.askId}:${status}`,
    at: now,
    text,
    ...(lastText ? { lastText } : {}),
    kind: 'ask-relay',
    conversationId: relay.conversationId,
    askId: relay.askId,
    status,
  };
}

/** 提问正文的完整说明：选项、默认值与截止时间都带上，秘书不必再读会话 */
function relayDetail(relay: SecretaryRelayAsk): string {
  const lines = [cap(relay.question)];
  if (relay.options && relay.options.length > 0) {
    lines.push(
      `选项：${relay.options.map((option, index) => `${index + 1}. ${option}`).join(' / ')}`
    );
  }
  if (relay.defaultOption) lines.push(`默认值：${relay.defaultOption}`);
  if (relay.expiresAt) {
    lines.push(
      `截止：${new Date(relay.expiresAt).toISOString()}（到点未答按默认值处理，没有默认值按无人值守拒绝）`
    );
  }
  return lines.join('\n');
}

export function pendingRelay(
  file: SecretaryDispatchFile,
  conversationId: string,
  askId: string
): SecretaryRelayAsk | undefined {
  return file.relays?.[relayKey(conversationId, askId)];
}

/**
 * 记下一条转交给秘书的提问，返回要投给它的更新。
 * 同一 askId 重复上报（重连、重放）只记一次、只推一条。
 */
export function openRelayAsk(
  file: SecretaryDispatchFile,
  input: OpenRelayInput,
  now: number
): SecretaryUpdate | null {
  const key = relayKey(input.conversationId, input.askId);
  if (file.relays?.[key]) return null;
  const relay: SecretaryRelayAsk = {
    conversationId: input.conversationId,
    askId: input.askId,
    question: cap(input.question),
    at: now,
    status: 'pending',
    ...(input.options && input.options.length > 0 ? { options: input.options.slice(0, 4) } : {}),
    ...(input.defaultOption ? { defaultOption: cap(input.defaultOption) } : {}),
    ...(input.expiresAt !== undefined ? { expiresAt: input.expiresAt } : {}),
  };
  file.relays = { ...(file.relays ?? {}), [key]: relay };
  return relayUpdate(
    relay,
    'pending',
    `${input.label} · 提问：${firstLine(input.question)}（askId: ${input.askId}）`,
    now,
    relayDetail(relay)
  );
}

/**
 * 提问收尾：秘书代答、用户在原会话里直接答、或超时兜底。
 * 已经收尾过的再报一次（事件重放）不再推更新。
 */
export function closeRelayAsk(
  file: SecretaryDispatchFile,
  input: CloseRelayInput,
  now: number,
  label: string
): { relay: SecretaryRelayAsk | undefined; update: SecretaryUpdate | null } {
  const key = relayKey(input.conversationId, input.askId);
  const relay = file.relays?.[key];
  if (!relay) return { relay: undefined, update: null };
  if (relay.status !== 'pending') return { relay, update: null };
  const status =
    input.by === 'relay' ? 'answered' : input.by === 'user' ? 'user-answered' : 'timed-out';
  const answer = input.answer ? cap(input.answer) : undefined;
  const next: SecretaryRelayAsk = {
    ...relay,
    status,
    answeredAt: now,
    ...(answer ? { answer } : {}),
  };
  file.relays = { ...(file.relays ?? {}), [key]: next };
  const text =
    status === 'answered'
      ? `${label} · 已代答：${firstLine(answer ?? '')}`
      : status === 'user-answered'
        ? `${label} · 用户已直接回答：${firstLine(answer ?? '')}`
        : `${label} · 提问超时未处理：${
            relay.defaultOption ? `已按默认值「${relay.defaultOption}」处理` : '已按无人值守拒绝'
          }`;
  return { relay: next, update: relayUpdate(next, status, text, now) };
}

/** 会话不再由秘书跟踪：挂起的转交一并作废，免得 session_answer 答到没人等的提问上 */
export function dropRelaysFor(file: SecretaryDispatchFile, conversationId: string): boolean {
  if (!file.relays) return false;
  const kept = Object.entries(file.relays).filter(
    ([, relay]) => relay.conversationId !== conversationId
  );
  if (kept.length === Object.keys(file.relays).length) return false;
  file.relays = kept.length > 0 ? Object.fromEntries(kept) : undefined;
  return true;
}

/** 提问被取消（会话中止、worker 换代）：记录直接作废，不再回传 */
export function dropRelay(
  file: SecretaryDispatchFile,
  conversationId: string,
  askId: string
): boolean {
  const key = relayKey(conversationId, askId);
  if (!file.relays?.[key]) return false;
  const kept = Object.entries(file.relays).filter(([entryKey]) => entryKey !== key);
  file.relays = kept.length > 0 ? Object.fromEntries(kept) : undefined;
  return true;
}

/** 会话的一句话标签：项目名 · 标题，回传正文与卡片都用它 */
export function sessionLabel(projectName: string, title: string, conversationId: string): string {
  return [projectName, title || conversationId].filter(Boolean).join(' · ');
}
