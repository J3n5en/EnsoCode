import {
  formatGoalResultChecks,
  formatGoalResultClaims,
  hasNeedsUser,
} from '@shared/secretary/goalResult';
import { queuedStartOf, queuePositions } from '@shared/secretary/queuedSession';
import { wrapUntrusted } from '@shared/secretary/transcript';
import type { ProjectAuthority, TurnReport } from '@shared/types/agent';
import { TURN_REPORT_MAX_CHARS } from '@shared/types/agentConstants';
import {
  type DispatchRecord,
  NEEDS_YOU_RESULTS,
  type PendingDispatch,
  type SecretaryBoard,
  type SecretaryCard,
  type SecretaryDispatchFile,
  type SecretaryProposal,
  type SecretaryResultKind,
  type SecretaryTakeoverView,
  type SecretaryTodo,
  type SecretaryUntrackedView,
  type SecretaryUpdate,
} from '@shared/types/secretary';
import { type GoalUpstreamRetry, parseGoalUpstreamRetry } from '@shared/upstreamRecovery';
import { redactSecrets } from '../memory/distill';
import { secretaryProjectName } from './projectLabel';
import type { SecretarySessionStatus } from './readers';
import { todoSessionView, todoStatus } from './todoLifecycle';

/** 运行中超过这么久没有任何 worker 事件就算可能卡住 */
export const STALL_MS = 10 * 60 * 1000;
export const BATCH_MAX_ITEMS = 20;
export const BATCH_MAX_CHARS = 12_000;
/** 单条"最后说了什么"的上限：工作台、手机与停滞回传只需要一句；终态与一轮结束回传见 reportLastText */
export const LAST_TEXT_MAX_CHARS = 500;
/** 一轮结束回传给秘书的正文上限：比工作台那一句长，比终态汇报短 */
export const TURN_ENDED_TEXT_MAX_CHARS = 2000;
/** 同一会话的普通回传先攒着，到点只投最新一条。档案里的 updateWindowMs 可改成 1–60 秒 */
export const UPDATE_WINDOW_MS = 45_000;
export { ACTIVITY_LIMIT } from '@shared/secretary/feed';

/** worker 事件里与结果分类有关的部分；其余事件只刷新活动时间 */
export type ResultEvent =
  | {
      type: 'turn-completed';
      aborted?: boolean;
      goalStatus?: string;
      goalCompleted?: boolean;
      /** 整轮没有任何文字回复、最后一步是工具调用：静默收工，按停滞报 */
      silentFinish?: { name: string; ok: boolean };
    }
  | { type: 'turn-failed'; error?: string }
  /** 应用退出（含安装更新）打断的一轮：不是失败，也不是用户主动中止 */
  | { type: 'turn-interrupted'; at: number; kind: 'quit' | 'update' }
  | { type: 'worker-exited' }
  | { type: 'goal-signal'; kind: 'complete' | 'blocked' | 'wait' }
  | { type: 'needs-user' };

/**
 * 结果类型判定。会话空闲不等于事情做成了：只有目标信号能说完成，
 * 无目标的轮次结束只能说"它停下了"。
 * 需要用户只看真实挂起的提问与审批：goal_wait 是在等后台任务、CI 等外部事情，不是等用户。
 * goal-blocked 只认模型调用的 goal_blocked。等后台任务、安全限制暂停、回合结束都不是受阻。
 * goal_complete 先记下，等这一轮真正结束再报，避免会话还在跑就通知完成。
 */
export function classify(
  _record: DispatchRecord,
  event: ResultEvent,
  status: SecretarySessionStatus
): SecretaryResultKind | null {
  switch (event.type) {
    case 'worker-exited':
    case 'turn-failed':
      return 'failed';
    case 'turn-interrupted':
      return 'interrupted';
    case 'goal-signal':
      if (event.kind === 'complete') return null;
      if (event.kind === 'blocked') return 'goal-blocked';
      return status.pendingAsks + status.pendingApprovals > 0 ? 'needs-user' : null;
    case 'needs-user':
      return 'needs-user';
    case 'turn-completed': {
      // 用户亲手中断的轮次不是结果
      if (event.aborted) return null;
      if (status.pendingAsks + status.pendingApprovals > 0) return 'needs-user';
      // 静默收工：最后一步是工具调用、助手一个字都没写。先于目标判定，带目标的也要报
      if (event.silentFinish) return 'stalled';
      if (event.goalCompleted) return 'goal-complete';
      // 目标是否还在只看会话行：派出记录里的 goal 是派出时的初始目标文本，目标完成后仍留着
      if (event.goalStatus === undefined) return 'turn-ended';
      return null;
    }
  }
}

/** 运行中、十分钟无事件、该轮还没报过；等待审批与 worker 已退出都不算停滞。
 *  空闲等后台任务的超时、进程已死、完成未唤醒由 driver 看门狗另报，不走这里。 */
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
): update is Extract<SecretaryUpdate, { kind: SecretaryResultKind }> {
  // 转交提问也带会话 id，但它不是这一轮的结果：不参与「同一会话只留最新结果」的替换
  // 遗留巡检同理：它说的是后台任务，不是这一轮的结论
  // 排队会话的启动失败与取消也不是一轮的结论
  return (
    'conversationId' in update &&
    update.kind !== 'ask-relay' &&
    update.kind !== 'leftover' &&
    update.kind !== 'queued'
  );
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

export function isUrgentUpdate(update: { kind: string }): boolean {
  return update.kind === 'needs-user' || update.kind === 'failed' || update.kind === 'ask-relay';
}

/** 会话收口或要人处理的结果：产生即投，不等合并窗口。只放行自己，不像 urgent 那样带走整批 */
const IMMEDIATE_RESULTS: ReadonlySet<string> = new Set<SecretaryResultKind>([
  'goal-complete',
  'goal-blocked',
  'interrupted',
  'failed',
  'needs-user',
]);

export function skipsUpdateWindow(kind: SecretaryResultKind): boolean {
  return IMMEDIATE_RESULTS.has(kind);
}

/** 静默收工的回传正文：点名最后一个工具和它是不是成功 */
export function silentFinishDetail(tool: { name: string; ok: boolean }): string {
  return `一轮结束时没有任何文字回复，最后一步是工具 ${tool.name}（${tool.ok ? '成功' : '失败'}）`;
}

/** 有需要你处理或失败时整批立刻走；否则只投已经到点的 */
export function dueUpdates(updates: readonly SecretaryUpdate[], now: number): SecretaryUpdate[] {
  if (updates.some((update) => isUrgentUpdate(update))) return [...updates];
  return updates.filter((update) => update.deliverAt === undefined || update.deliverAt <= now);
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
  return 'conversationId' in update ? `session:${update.conversationId}` : 'secretary';
}

function formatLine(update: SecretaryUpdate): string {
  const marker =
    'conversationId' in update
      ? ` session:${update.conversationId}`
      : update.kind === 'pending'
        ? ` pending:${update.pendingId}`
        : '';
  const head = `- [${update.kind}${marker}] ${update.text}`;
  const lines = [head];
  if (update.goalResult?.checks && update.goalResult.checks.length > 0) {
    lines.push(formatGoalResultChecks(update.goalResult));
  }
  const claims = update.goalResult ? formatGoalResultClaims(update.goalResult.result) : '';
  const body = [update.lastText, claims].filter((part) => part && part.length > 0).join('\n');
  if (!body) return lines.join('\n');
  return `${lines.join('\n')}\n${wrapUntrusted(untrustedSource(update), redactSecrets(body))}`;
}

/**
 * 回传给秘书的正文：最后一句先脱敏再包成不可信内容，防止会话正文里的指令被当成命令。
 * 定时到点是秘书自己写的待办，与派出会话的结果分开包裹，模型才知道哪条该照做。
 */
export function formatSessionUpdates(batch: readonly SecretaryUpdate[]): string {
  const blocks: string[] = [];
  const results = batch.filter(
    (update) => update.kind !== 'schedule' && update.kind !== 'peer-message'
  );
  const schedules = batch.filter((update) => update.kind === 'schedule');
  const peers = batch.filter(
    (update): update is Extract<SecretaryUpdate, { kind: 'peer-message' }> =>
      update.kind === 'peer-message'
  );
  if (results.length > 0)
    blocks.push(`<session-updates>\n${results.map(formatLine).join('\n')}\n</session-updates>`);
  if (schedules.length > 0)
    blocks.push(
      `<secretary-schedule>\n${schedules.map(formatLine).join('\n')}\n</secretary-schedule>`
    );
  // 同事的话是请求，不是用户指令：正文一律按不可信内容包起来
  if (peers.length > 0)
    blocks.push(
      `<secretary-message>\n${peers
        .map(
          (update) =>
            `- [from ${update.fromName} secretaryId=${update.fromSecretaryId} chain=${update.chain} hop=${update.hop}]\n${wrapUntrusted(`secretary:${update.fromSecretaryId}`, redactSecrets(update.text))}`
        )
        .join('\n')}\n</secretary-message>`
    );
  return blocks.join('\n');
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

const PENDING_PROBLEM_TEXT: Record<NonNullable<PendingDispatch['problem']>, string> = {
  'dependency-failed': '依赖的会话失败了，这条派发没有开始',
  'dependency-stopped': '依赖的会话被停止了，这条派发没有开始',
  'dependency-deleted': '依赖的会话被删除了，这条派发没有开始',
  'dispatch-failed': '依赖都结束了，但这条派发没能建起来',
  cancelled: '这条派发在等依赖时被取消了',
};

/** 等依赖的派发：开始或出问题时给秘书推一条，key 按派发 id 去重 */
export function pendingUpdate(pending: PendingDispatch, at: number): SecretaryUpdate {
  const failed = pending.status === 'failed';
  const dependency = pending.failedDependency ? ` session:${pending.failedDependency}` : '';
  const title = pending.draft.title?.trim() || pending.draft.prompt.split('\n')[0]?.trim() || '';
  const head = failed
    ? PENDING_PROBLEM_TEXT[pending.problem ?? 'dispatch-failed']
    : '依赖都结束了，这条派发已经开始';
  return {
    key: `pending:${pending.id}:${pending.status}`,
    at,
    text: [title, head, dependency].filter(Boolean).join(' · '),
    kind: 'pending',
    pendingId: pending.id,
    status: pending.status,
    ...(pending.problem ? { problem: pending.problem } : {}),
    secretaryConversationId: pending.secretaryConversationId,
  };
}

function proposalUpdateText(proposal: SecretaryProposal): string {
  // 清理卡回传要带上执行结果：删了几个、跳过了什么，秘书才知道要不要再提一次
  if (proposal.kind === 'cleanup') {
    if (proposal.status === 'executing') return '已确认，正在执行清理';
    if (proposal.status === 'succeeded') return `清理完成：${proposal.report ?? '无动作'}`;
    if (proposal.status === 'rejected') return '用户取消了这次清理，什么都没删';
  }
  // 接管卡回传要点名会话，秘书才知道之后能操作哪一个
  if (proposal.kind === 'takeover') {
    const session = `session:${proposal.draft.conversationId}`;
    if (proposal.status === 'executing') return `用户已确认接管 ${session}，正在处理`;
    if (proposal.status === 'succeeded') return `用户同意了接管，${session} 现在交给你管`;
    if (proposal.status === 'rejected') return `用户取消了接管 ${session}`;
  }
  switch (proposal.status) {
    case 'executing':
      return '已确认，正在执行';
    case 'succeeded':
      return '提案已执行';
    case 'failed':
      return `提案执行失败：${proposal.error ?? 'unknown'}`;
    case 'rejected':
      return '用户取消了提案';
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

/**
 * 终态回传带上这一轮的完整汇报，秘书不用再读一遍会话就能报出提交号与测试数字。
 * 一轮结束带 TURN_ENDED_TEXT_MAX_CHARS，没有汇报时用摘要正文。超过上限只留结尾：结论通常在末尾。
 * 停滞返回 undefined，仍走 capLastText。
 */
export function reportLastText(
  kind: SecretaryResultKind,
  report: TurnReport | undefined,
  digestText?: string
): string | undefined {
  if (kind === 'turn-ended') {
    const full = report?.text.trim();
    const text = full || digestText?.trim();
    if (!text) return undefined;
    return keepTail(text, TURN_ENDED_TEXT_MAX_CHARS, full ? (report?.omitted ?? 0) : 0);
  }
  if (!IMMEDIATE_RESULTS.has(kind)) return undefined;
  const text = report?.text.trim();
  if (!text) return undefined;
  return keepTail(text, TURN_REPORT_MAX_CHARS, report?.omitted ?? 0);
}

function keepTail(text: string, max: number, omittedBefore: number): string {
  const kept = text.slice(-max);
  const omitted = omittedBefore + text.length - kept.length;
  return omitted > 0 ? `[已截断：前面省略 ${omitted} 字，以下是结尾]\n${kept}` : kept;
}

export function goalStatusOf(row: Record<string, unknown> | undefined): string | undefined {
  const goal = row?.goal;
  if (!goal || typeof goal !== 'object' || Array.isArray(goal)) return undefined;
  const status = (goal as Record<string, unknown>).status;
  return typeof status === 'string' ? status : undefined;
}

/** 已经收口的结果：目标做完、报错、被中断。再空闲就是真的结束了 */
export const SETTLED_RESULTS: ReadonlySet<SecretaryResultKind> = new Set([
  'goal-complete',
  'failed',
  'interrupted',
]);

export type SessionLiveState = 'running' | 'idle' | 'waiting' | 'error' | 'not-started' | 'queued';

/** 行上有 queuedStart 的是排队会话；没有会话文件的派发记录还没真正开始 */
export function sessionLiveState(
  row: Record<string, unknown> | undefined,
  status: SecretarySessionStatus | undefined
): SessionLiveState {
  if (queuedStartOf(row)) return 'queued';
  if (!row?.sessionFile) return 'not-started';
  return status?.state ?? 'idle';
}

/** 卡片与计数共用的状态：刚 session_send 时实时状态可能还是空闲，记录已经标回运行中 */
export function sessionStateOf(
  record: DispatchRecord,
  row: Record<string, unknown> | undefined,
  status: SecretarySessionStatus | undefined
): SessionLiveState {
  const live = sessionLiveState(row, status);
  // 秘书停止过的不算：停止写了 idle，残留的 running 是停止之前的旧记录
  if (record.stoppedAt !== undefined) return live;
  // 会话文件还没出现时实时状态是 not-started：记录已经标回运行中，照样算在跑，
  // 否则状态推送被节流时，刚派出的会话会在看板上停在「未开始」
  return (live === 'idle' || live === 'not-started') && record.lastState === 'running'
    ? 'running'
    : live;
}

/**
 * 派发或接管的会话还没真正结束。顶栏、看板「进行中」和派出上限共用这一个口径。
 * 正在跑、刚被 session_send 唤起、还有等唤醒的后台任务、目标还会自动续跑，都算。
 * 常驻服务（dev server、http.server）不会自己结束，只标出来，不算在跑。
 * 报错、等用户审批或提问、还没开始、已经收口的结果都不算。
 * 目标停在 waiting 只有后台任务的完成通知会唤醒它；没有后台任务就没人叫它，不算在跑。
 * 已经有终态结果的会话被重新唤起时，只有这一轮还没结束（reopened）才算在跑：
 * 轮次一结束就回到终态，不能因为 lastState 还残留 running 一直挂在进行中。
 */
export function sessionStillGoing(input: {
  state: SessionLiveState;
  recordedState?: DispatchRecord['lastState'];
  goalStatus?: string;
  backgroundRunning?: boolean;
  lastResult?: DispatchRecord['lastResult'];
  /** 终态之后被重新唤起、这一轮还没结束 */
  reopened?: boolean;
  /** 秘书停止或取消过：停止是明确的收口，残留的运行中与后台任务记录都不能再算在跑 */
  stopped?: boolean;
}): boolean {
  if (input.state === 'running') return true;
  if (input.state !== 'idle') return false;
  if (input.lastResult && SETTLED_RESULTS.has(input.lastResult.kind))
    return input.reopened === true;
  if (input.stopped) return false;
  if (input.recordedState === 'running') return true;
  if (input.backgroundRunning) return true;
  return input.goalStatus === 'active';
}

export function upstreamRetryOf(
  row: Record<string, unknown> | undefined
): GoalUpstreamRetry | undefined {
  const goal = row?.goal;
  if (!goal || typeof goal !== 'object') return undefined;
  const record = goal as Record<string, unknown>;
  if (record.status !== 'waiting') return undefined;
  return parseGoalUpstreamRetry(record.retry);
}

/** 一条派发记录此刻算不算在跑；三处计数都走这里 */
export function countsAsRunning(
  record: DispatchRecord,
  row: Record<string, unknown> | undefined,
  status: SecretarySessionStatus | undefined
): boolean {
  // 正在启动的排队会话已经占了名额：否则启动期间并发的派发会多建一个
  const queued = queuedStartOf(row);
  if (queued) return queued.startingAt !== undefined;
  const state = sessionStateOf(record, row, status);
  if (sessionNeedsUser(record, state)) return false;
  if (record.stoppedAt !== undefined && state !== 'running') return false;
  if (upstreamRetryOf(row)) return true;
  // 用户撤销手动标记：放回进行中，直到这一轮出现新结果
  if (record.manualUndoneAt !== undefined && record.lastResult === undefined) return true;
  return sessionStillGoing({
    state,
    recordedState: record.lastState,
    goalStatus: goalStatusOf(row),
    backgroundRunning: record.backgroundRunning === true,
    lastResult: record.lastResult,
    reopened: record.reopenedAt !== undefined,
    stopped: record.stoppedAt !== undefined,
  });
}

export function sessionNeedsUser(record: DispatchRecord, state: SessionLiveState): boolean {
  if (state === 'waiting') return true;
  const result = record.lastResult;
  if (!result || result.dismissed) return false;
  if (result.kind === 'goal-complete' || result.kind === 'goal-blocked') {
    return !result.manual && hasNeedsUser(record.goalResult);
  }
  return NEEDS_YOU_RESULTS.has(result.kind);
}

/** 待办看到的会话：记录上还在跑、或目标还要续时，不因实时状态暂时空闲就当成做完 */
export function linkedTodoSession(
  record: DispatchRecord | undefined,
  row: Record<string, unknown> | undefined,
  status: { state: 'running' | 'idle' | 'waiting' | 'error' } | undefined,
  aborted = false
) {
  const view = todoSessionView(row, status, record?.lastResult?.kind, aborted);
  if (!record || !view.present || view.state !== 'idle') return view;
  const going = sessionStillGoing({
    state: view.state,
    recordedState: record.lastState,
    goalStatus: goalStatusOf(row),
    backgroundRunning: record.backgroundRunning === true,
    lastResult: record.lastResult,
    reopened: record.reopenedAt !== undefined,
    stopped: record.stoppedAt !== undefined,
  });
  return going ? { ...view, state: 'running' as const } : view;
}

export interface BoardInput {
  rows: Readonly<Record<string, Record<string, unknown>>>;
  statuses: Readonly<Record<string, SecretarySessionStatus>>;
  projects: readonly ProjectAuthority[];
  todos: readonly SecretaryTodo[];
  aliases?: Readonly<Record<string, string>>;
}

type SessionCard = Extract<SecretaryCard, { kind: 'session' }>;

/** 工作台投影：与 session_list 同源（会话行 + 会话状态 + 项目），不另建一份任务数据 */
export function buildBoard(file: SecretaryDispatchFile, input: BoardInput): SecretaryBoard {
  const projectName = (projectId: string): string => {
    const project = input.projects.find((candidate) => candidate.projectId === projectId);
    return secretaryProjectName(project, input.aliases);
  };

  const needsYou: SecretaryCard[] = Object.values(file.proposals)
    .filter((proposal) => proposal.status === 'pending')
    .sort((left, right) => left.createdAt - right.createdAt)
    .map((proposal) => ({
      kind: 'proposal',
      proposal,
      ...(proposal.kind === 'dispatch' || proposal.kind === 'takeover'
        ? { projectName: projectName(proposal.draft.projectId) }
        : {}),
    }));

  const running: SecretaryCard[] = [];
  const queuedCards: { card: SecretaryCard; at: number }[] = [];
  const done: SessionCard[] = [];
  const positions = queuePositions(input.rows);
  for (const record of Object.values(file.dispatched)) {
    const row = input.rows[record.conversationId];
    if (!row) continue;
    // 用户从看板上移出：记录与会话都还在，只是不再占工作台的列
    if (record.dismissedFromBoard === true) continue;
    const status = input.statuses[record.conversationId];
    const state = sessionStateOf(record, row, status);
    const going = countsAsRunning(record, row, status);
    const queued = queuedStartOf(row);
    const upstreamRetry = upstreamRetryOf(row);
    const position = positions.get(record.conversationId);
    // 巡检报过停住、之后没有新活动：进行中列表标「已停住」，等它真的动起来才消失
    const stalled =
      going &&
      record.patrol &&
      record.patrol.turn === record.turn &&
      record.lastEventAt <= record.patrol.at
        ? { reason: record.patrol.reason, at: record.patrol.at }
        : undefined;
    const card: SessionCard = {
      kind: 'session',
      conversationId: record.conversationId,
      projectId: record.projectId,
      projectName: projectName(record.projectId),
      title: typeof row.title === 'string' ? row.title : '',
      state,
      startedAt: record.createdAt,
      stateSince: record.stateSince ?? Math.max(record.createdAt, record.lastResult?.at ?? 0),
      secretaryConversationId: record.secretaryConversationId,
      ...(record.lastText ? { lastText: redactSecrets(record.lastText) } : {}),
      ...(record.lastResult
        ? { result: record.lastResult.kind, resultAt: record.lastResult.at }
        : {}),
      ...(record.lastResult?.manual ? { manual: true as const } : {}),
      ...(going && state !== 'running' ? { continuing: true as const } : {}),
      ...(upstreamRetry ? { upstreamRetry } : {}),
      ...(going && record.backgroundRunning ? { backgroundRunning: true as const } : {}),
      ...(going && record.backgroundPersistent ? { backgroundPersistent: true as const } : {}),
      ...(stalled ? { stalled } : {}),
      ...(!going && record.leftoverTasks
        ? { leftoverTasks: { count: record.leftoverTasks.count } }
        : {}),
      ...(record.takeover ? { takeover: true as const } : {}),
      ...(record.checkout ? { checkout: record.checkout } : {}),
      ...(record.baseRef ? { baseRef: record.baseRef } : {}),
      ...(record.branch ? { branch: record.branch } : {}),
      ...(record.model ? { model: record.model } : {}),
      ...(position !== undefined ? { queuePosition: position } : {}),
      ...(queued?.failed ? { queueFailed: queued.failed.error } : {}),
    };
    // 排队会话放在真正在跑的后面；自动启动失败的要用户立即开始或取消
    if (queued) {
      if (queued.failed) needsYou.push(card);
      else queuedCards.push({ card, at: queued.queuedAt });
      continue;
    }
    const needsYouNow = sessionNeedsUser(record, state);
    if (needsYouNow) needsYou.push(card);
    else if (going) running.push(card);
    else done.push(card);
  }
  // 等依赖的派发还没有会话：等待中算进行中，出问题进「需要你处理」
  for (const pending of Object.values(file.pending ?? {})) {
    const card: SecretaryCard = {
      kind: 'pending',
      pending,
      projectName: projectName(pending.projectId),
    };
    if (pending.status === 'failed') needsYou.push(card);
    else running.push(card);
  }
  running.sort(
    (left, right) => cardAt(right) - cardAt(left) || cardKey(left).localeCompare(cardKey(right))
  );
  queuedCards.sort(
    (left, right) => left.at - right.at || cardKey(left.card).localeCompare(cardKey(right.card))
  );
  running.push(...queuedCards.map((entry) => entry.card));
  done.sort(
    (left, right) =>
      (right.resultAt ?? right.stateSince) - (left.resultAt ?? left.stateSince) ||
      left.conversationId.localeCompare(right.conversationId)
  );

  return {
    needsYou,
    running,
    done,
    todos: input.todos.flatMap((todo) => {
      const session = todo.conversationId
        ? linkedTodoSession(
            file.dispatched[todo.conversationId],
            input.rows[todo.conversationId],
            input.statuses[todo.conversationId]
          )
        : null;
      const phase = todoStatus(todo, session);
      if (phase === 'done') return [];
      const project = todo.projectId
        ? input.projects.find((candidate) => candidate.projectId === todo.projectId)
        : undefined;
      return [
        {
          ...todo,
          phase,
          ...(project ? { projectName: secretaryProjectName(project, input.aliases) } : {}),
          ...(session?.title ? { sessionTitle: redactSecrets(session.title) } : {}),
          ...(todo.conversationId
            ? { sessionState: session?.present ? session.state : ('gone' as const) }
            : {}),
        },
      ];
    }),
    ...(file.activity && file.activity.length > 0 ? { activity: file.activity } : {}),
  };
}

/** 排序兜底键：会话用会话 id，等依赖的派发用派发 id */
function cardKey(card: SecretaryCard): string {
  if (card.kind === 'session') return card.conversationId;
  if (card.kind === 'pending') return card.pending.id;
  return card.proposal.id;
}

/** 进行中的排序时间：等依赖的派发按它自己的更新时间 */
function cardAt(card: SecretaryCard): number {
  if (card.kind === 'pending') return card.pending.updatedAt;
  if (card.kind === 'session') return card.stateSince;
  return card.proposal.updatedAt;
}

/** 接管清单：会话行已删的不列；按授权时间新的在前 */
export function takeoverViews(
  file: SecretaryDispatchFile,
  rows: Readonly<Record<string, Record<string, unknown>>>,
  projects: readonly ProjectAuthority[],
  aliases: Readonly<Record<string, string>> = {}
): SecretaryTakeoverView[] {
  const views: SecretaryTakeoverView[] = [];
  for (const record of Object.values(file.dispatched)) {
    if (!record.takeover) continue;
    const row = rows[record.conversationId];
    if (!row) continue;
    const project = projects.find((candidate) => candidate.projectId === record.projectId);
    views.push({
      conversationId: record.conversationId,
      projectId: record.projectId,
      projectName: secretaryProjectName(project, aliases),
      title: typeof row.title === 'string' ? row.title : '',
      grantedAt: record.takeover.grantedAt,
      via: record.takeover.via,
      secretaryConversationId: record.secretaryConversationId,
    });
  }
  return views.sort((left, right) => right.grantedAt - left.grantedAt);
}

/**
 * 「不再跟踪」名单：会话行已删的不列；顺序沿用名单本身（最近收回的在前）。
 * 记录里没有项目 id，按会话行反查。
 */
export function untrackedViews(
  file: SecretaryDispatchFile,
  rows: Readonly<Record<string, Record<string, unknown>>>,
  projects: readonly ProjectAuthority[],
  aliases: Readonly<Record<string, string>> = {}
): SecretaryUntrackedView[] {
  const views: SecretaryUntrackedView[] = [];
  for (const conversationId of file.untracked ?? []) {
    const row = rows[conversationId];
    if (!row) continue;
    const projectId = typeof row.projectId === 'string' ? row.projectId : '';
    const project = projects.find((candidate) => candidate.projectId === projectId);
    views.push({
      conversationId,
      projectId,
      projectName: secretaryProjectName(project, aliases),
      title: typeof row.title === 'string' ? row.title : '',
    });
  }
  return views;
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
