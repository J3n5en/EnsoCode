import { projectNameFromPath } from '@shared/projectName';
import { wrapUntrusted } from '@shared/secretary/transcript';
import type { ProjectAuthority } from '@shared/types/agent';
import type {
  DispatchRecord,
  SecretaryBoard,
  SecretaryCard,
  SecretaryDispatchFile,
  SecretaryProposal,
  SecretaryResultKind,
  SecretaryTodo,
  SecretaryUpdate,
} from '@shared/types/secretary';
import { redactSecrets } from '../memory/distill';
import type { SecretarySessionStatus } from './readers';

/** 运行中超过这么久没有任何 worker 事件就算可能卡住 */
export const STALL_MS = 10 * 60 * 1000;
export const BATCH_MAX_ITEMS = 20;
export const BATCH_MAX_CHARS = 12_000;
/** 单条"最后说了什么"的上限：工作台与回传都只需要一句 */
export const LAST_TEXT_MAX_CHARS = 500;

/** worker 事件里与结果分类有关的部分；其余事件只刷新活动时间 */
export type ResultEvent =
  | { type: 'turn-completed'; aborted?: boolean; goalStatus?: string }
  | { type: 'turn-failed'; error?: string }
  | { type: 'worker-exited' }
  | { type: 'goal-signal'; kind: 'complete' | 'blocked' | 'wait' }
  | { type: 'needs-user' };

/**
 * 结果类型判定。会话空闲不等于事情做成了：只有目标信号能说完成，
 * 无目标的轮次结束只能说"它停下了"。
 */
export function classify(
  record: DispatchRecord,
  event: ResultEvent,
  status: SecretarySessionStatus
): SecretaryResultKind | null {
  switch (event.type) {
    case 'worker-exited':
    case 'turn-failed':
      return 'failed';
    case 'goal-signal':
      if (event.kind === 'complete') return 'goal-complete';
      return event.kind === 'blocked' ? 'goal-blocked' : 'needs-user';
    case 'needs-user':
      return 'needs-user';
    case 'turn-completed': {
      // 用户亲手中断的轮次不是结果
      if (event.aborted) return null;
      if (status.pendingAsks + status.pendingApprovals > 0) return 'needs-user';
      const goal = event.goalStatus ?? (record.goal ? 'active' : undefined);
      if (goal === undefined) return 'turn-ended';
      // 完成与受阻由目标信号报过；轮次结束时只有安全限制暂停是新信息
      return goal === 'paused' ? 'goal-blocked' : null;
    }
  }
}

/** 运行中、十分钟无事件、该轮还没报过；等待审批与 worker 已退出都不算停滞 */
export function stalled(
  records: readonly DispatchRecord[],
  statuses: Readonly<Record<string, SecretarySessionStatus>>,
  now: number
): { conversationId: string; turn: number }[] {
  const out: { conversationId: string; turn: number }[] = [];
  for (const record of records) {
    if (record.lastState !== 'running') continue;
    const status = statuses[record.conversationId];
    if (status?.state !== 'running') continue;
    if (status.pendingAsks + status.pendingApprovals > 0) continue;
    if (record.stalledTurn === record.turn) continue;
    if (now - record.lastEventAt < STALL_MS) continue;
    out.push({ conversationId: record.conversationId, turn: record.turn });
  }
  return out;
}

export function updateKey(conversationId: string, kind: SecretaryResultKind, turn: number): string {
  return `${conversationId}|${kind}|${turn}`;
}

function isResultUpdate(
  update: SecretaryUpdate
): update is Extract<SecretaryUpdate, { conversationId: string }> {
  return 'conversationId' in update;
}

/** 同一件事只入队一次；同一会话只保留最新结果，旧状态已被新状态取代 */
export function enqueueUpdate(
  outbox: readonly SecretaryUpdate[],
  update: SecretaryUpdate
): SecretaryUpdate[] {
  if (outbox.some((entry) => entry.key === update.key)) return [...outbox];
  const kept = isResultUpdate(update)
    ? outbox.filter(
        (entry) => !(isResultUpdate(entry) && entry.conversationId === update.conversationId)
      )
    : [...outbox];
  return [...kept, update];
}

export function takeBatch(
  outbox: readonly SecretaryUpdate[],
  options: { max: number; maxChars: number; skipKeys?: readonly string[] }
): SecretaryUpdate[] {
  const skip = new Set(options.skipKeys ?? []);
  const batch: SecretaryUpdate[] = [];
  let chars = 0;
  for (const update of outbox) {
    if (skip.has(update.key)) continue;
    if (batch.length >= options.max) break;
    const size = update.text.length + (update.lastText?.length ?? 0);
    // 首条再长也要投出去，否则批次永远卡在这一条
    if (batch.length > 0 && chars + size > options.maxChars) break;
    batch.push(update);
    chars += size;
  }
  return batch;
}

function untrustedSource(update: SecretaryUpdate): string {
  return isResultUpdate(update) ? `session:${update.conversationId}` : 'secretary';
}

/** 回传给秘书的正文：最后一句先脱敏再包成不可信内容，防止会话正文里的指令被当成命令 */
export function formatSessionUpdates(batch: readonly SecretaryUpdate[]): string {
  const lines = batch.map((update) => {
    const head = `- [${update.kind}] ${update.text}`;
    if (!update.lastText) return head;
    return `${head}\n${wrapUntrusted(untrustedSource(update), redactSecrets(update.lastText))}`;
  });
  return `<session-updates>\n${lines.join('\n')}\n</session-updates>`;
}

export function proposalUpdate(proposal: SecretaryProposal, at: number): SecretaryUpdate {
  return {
    key: `proposal:${proposal.id}:${proposal.status}`,
    at,
    text: proposalUpdateText(proposal),
    kind: 'proposal',
    proposalId: proposal.id,
    status: proposal.status,
    secretaryConversationId: proposal.secretaryConversationId,
  };
}

function proposalUpdateText(proposal: SecretaryProposal): string {
  switch (proposal.status) {
    case 'succeeded':
      return '提案已执行';
    case 'failed':
      return `提案执行失败：${proposal.error ?? 'unknown'}`;
    case 'rejected':
      return '用户拒绝了提案';
    case 'expired':
      return '提案超过 24 小时未处理，已过期';
    default:
      return `提案状态：${proposal.status}`;
  }
}

export function capLastText(text: string | undefined): string | undefined {
  const trimmed = text?.trim();
  if (!trimmed) return undefined;
  return trimmed.length > LAST_TEXT_MAX_CHARS
    ? `${trimmed.slice(0, LAST_TEXT_MAX_CHARS)}…`
    : trimmed;
}

export interface BoardInput {
  rows: Readonly<Record<string, Record<string, unknown>>>;
  statuses: Readonly<Record<string, SecretarySessionStatus>>;
  projects: readonly ProjectAuthority[];
  todos: readonly SecretaryTodo[];
}

type SessionCard = Extract<SecretaryCard, { kind: 'session' }>;

const NEEDS_YOU_RESULTS: ReadonlySet<SecretaryResultKind> = new Set(['failed', 'needs-user']);

/** 工作台投影：与 session_list 同源（会话行 + 会话状态 + 项目），不另建一份任务数据 */
export function buildBoard(file: SecretaryDispatchFile, input: BoardInput): SecretaryBoard {
  const projectName = (projectId: string): string => {
    const project = input.projects.find((candidate) => candidate.projectId === projectId);
    return project ? projectNameFromPath(project.canonicalPath) : '';
  };

  const needsYou: SecretaryCard[] = Object.values(file.proposals)
    .filter((proposal) => proposal.status === 'pending')
    .sort((left, right) => left.createdAt - right.createdAt)
    .map((proposal) => ({
      kind: 'proposal',
      proposal,
      ...(proposal.kind === 'dispatch'
        ? { projectName: projectName(proposal.draft.projectId) }
        : {}),
    }));

  const running: SessionCard[] = [];
  const done: SessionCard[] = [];
  for (const record of Object.values(file.dispatched)) {
    const row = input.rows[record.conversationId];
    if (!row) continue;
    const status = input.statuses[record.conversationId];
    const card: SessionCard = {
      kind: 'session',
      conversationId: record.conversationId,
      projectId: record.projectId,
      projectName: projectName(record.projectId),
      title: typeof row.title === 'string' ? row.title : '',
      state: row.sessionFile ? (status?.state ?? 'idle') : 'not-started',
      startedAt: record.createdAt,
      secretaryConversationId: record.secretaryConversationId,
      ...(record.lastText ? { lastText: redactSecrets(record.lastText) } : {}),
      ...(record.lastResult ? { result: record.lastResult.kind } : {}),
    };
    const needsYouNow =
      card.state === 'waiting' ||
      (record.lastResult ? NEEDS_YOU_RESULTS.has(record.lastResult.kind) : false);
    if (needsYouNow) needsYou.push(card);
    else if (record.lastState === 'running') running.push(card);
    else done.push(card);
  }
  running.sort((left, right) => right.startedAt - left.startedAt);
  done.sort((left, right) => right.startedAt - left.startedAt);

  return {
    needsYou,
    running,
    done,
    todos: input.todos.filter((todo) => todo.doneAt === undefined),
  };
}

/** 系统通知只补通用通知没覆盖的结果；通用路径已经报过审批、提问、轮次完成与失败 */
export function shouldNotify(
  mode: 'needs-user' | 'with-done' | 'off',
  kind: SecretaryResultKind
): boolean {
  if (mode === 'off') return false;
  if (kind === 'goal-complete') return mode === 'with-done';
  return kind === 'goal-blocked' || kind === 'stalled' || kind === 'interrupted';
}
