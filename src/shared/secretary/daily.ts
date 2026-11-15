import type {
  DispatchRecord,
  SecretaryAuditEntry,
  SecretaryDaily,
  SecretaryDailyGroup,
  SecretaryDailyItem,
  SecretaryDailyRecord,
  SecretaryResultKind,
  SecretaryTodo,
} from '../types/secretary';

/** 结果记录（daily.jsonl）保留天数；派发记录与待办不清理，审计按体积轮转 */
export const DAILY_RETENTION_DAYS = 180;
/** 一句话摘要的长度上限，展开里给全文 */
const SUMMARY_MAX_CHARS = 160;

const DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/u;

function pad(value: number): string {
  return value < 10 ? `0${value}` : String(value);
}

/** 本地时区的一天；跨天按用户所在时区的零点切，不用 UTC */
export function dayKey(at: number): string {
  const date = new Date(at);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** 校验 YYYY-MM-DD 并确认是真实存在的日期（2024-02-31 不算） */
export function parseDayKey(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const match = DAY_RE.exec(value.trim());
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(year, month - 1, day);
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day)
    return null;
  return `${match[1]}-${match[2]}-${match[3]}`;
}

/** 本地零点 */
export function dayStart(day: string): number {
  const parsed = parseDayKey(day);
  if (!parsed) return Number.NaN;
  const [year, month, date] = parsed.split('-').map(Number);
  return new Date(year, month - 1, date).getTime();
}

/** 下一天零点：一天的范围是 [start, end) */
export function dayEnd(day: string): number {
  const start = dayStart(day);
  if (Number.isNaN(start)) return Number.NaN;
  const date = new Date(start);
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + 1).getTime();
}

/** 前后挪一天；跨月、跨年、夏令时都由 Date 自己算 */
export function shiftDay(day: string, delta: number): string {
  const start = dayStart(day);
  if (Number.isNaN(start)) return day;
  const date = new Date(start);
  return dayKey(new Date(date.getFullYear(), date.getMonth(), date.getDate() + delta).getTime());
}

export function inDay(at: number, day: string): boolean {
  return at >= dayStart(day) && at < dayEnd(day);
}

const COMMIT_RE = /(?:commit|commits?|提交|sha)[\s:：#`]*([0-9a-f]{7,40})\b/iu;
const BRANCH_RE = /(?:branch|分支)[\s:：`]*([A-Za-z0-9._/-]{2,80})/iu;
const MERGED_RE = /(?:merged|merge commit|merge pull request|已合并|合并到|合并进)/iu;

function trimRef(value: string): string | undefined {
  const trimmed = value.replace(/[.,;:)\]）】`]+$/u, '').trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * 从会话最终汇报里认分支与提交号。只认带关键词的写法，
 * 认不出来就什么都不给：宁可少显示，不猜。
 */
export function extractReportRefs(text: string | undefined): {
  branch?: string;
  commit?: string;
  merged?: true;
} {
  if (!text) return {};
  const commit = COMMIT_RE.exec(text)?.[1];
  const branch = BRANCH_RE.exec(text)?.[1];
  const refs: { branch?: string; commit?: string; merged?: true } = {};
  if (commit) refs.commit = commit.toLowerCase();
  const cleanBranch = branch ? trimRef(branch) : undefined;
  if (cleanBranch) refs.branch = cleanBranch;
  if (MERGED_RE.test(text)) refs.merged = true;
  return refs;
}

/** 列表里的一行：取第一行非空正文，太长截断 */
export function summarize(text: string | undefined): string | undefined {
  const line = text
    ?.split('\n')
    .map((entry) => entry.trim())
    .find((entry) => entry.length > 0);
  if (!line) return undefined;
  return line.length > SUMMARY_MAX_CHARS ? `${line.slice(0, SUMMARY_MAX_CHARS)}…` : line;
}

const DONE_KINDS: ReadonlySet<SecretaryResultKind> = new Set(['goal-complete']);
const FAILED_KINDS: ReadonlySet<SecretaryResultKind> = new Set([
  'failed',
  'interrupted',
  'stalled',
]);
const NEEDS_YOU_KINDS: ReadonlySet<SecretaryResultKind> = new Set(['needs-user', 'goal-blocked']);

const RESULT_LABEL: Partial<Record<SecretaryResultKind, string>> = {
  'goal-complete': 'Goal complete',
  failed: 'Failed',
  interrupted: 'Interrupted',
  stalled: 'Stalled',
  'needs-user': 'Waiting for you',
  'goal-blocked': 'Goal blocked',
};

/** 审计里算「设置和能力变更」的操作；其余操作（会话、待办、回传）不进看板 */
const CHANGE_LABEL: Record<string, string> = {
  profile_save: 'Secretary profile updated',
  profile_reset: 'Secretary profile reset',
  skill_save: 'Skill saved',
  skill_delete: 'Skill deleted',
  tool_save: 'Tool saved',
  tool_delete: 'Tool deleted',
  takeover_grant: 'Takeover granted',
  takeover_revoke: 'Takeover revoked',
};

export interface DailySessionMeta {
  title?: string;
  projectName?: string;
}

export interface DailyInput {
  day: string;
  now: number;
  results: readonly SecretaryDailyRecord[];
  dispatched: readonly DispatchRecord[];
  todos: readonly SecretaryTodo[];
  audit: readonly SecretaryAuditEntry[];
  /** 会话已删或不属于可见项目时返回空对象 */
  session?: (conversationId: string) => DailySessionMeta;
  projectName?: (projectId: string) => string;
  earliest?: string;
  retentionDays?: number;
}

function newestFirst(left: SecretaryDailyItem, right: SecretaryDailyItem): number {
  return right.at - left.at || left.id.localeCompare(right.id);
}

/** 终态结果落哪一列；中间态（turn-ended 之类）不上板 */
function columnOf(kind: SecretaryResultKind): 'done' | 'failed' | 'needsYou' | null {
  if (DONE_KINDS.has(kind)) return 'done';
  if (FAILED_KINDS.has(kind)) return 'failed';
  if (NEEDS_YOU_KINDS.has(kind)) return 'needsYou';
  return null;
}

/** 一个会话当天最后一条终态结果；record 只在 daily.jsonl 里有原文时存在 */
interface Terminal {
  at: number;
  kind: SecretaryResultKind;
  record?: SecretaryDailyRecord;
}

/**
 * 一天的看板投影。纯函数：数据由调用方从派发记录、daily.jsonl、审计与待办读出来，
 * renderer 不再拼凑。空分组不返回，界面据此不显示整组。
 */
export function buildSecretaryDaily(input: DailyInput): SecretaryDaily {
  const { day } = input;
  const start = dayStart(day);
  const end = dayEnd(day);
  const within = (at: number | undefined): at is number =>
    at !== undefined && at >= start && at < end;
  const session: (conversationId: string) => DailySessionMeta = input.session ?? (() => ({}));
  const projectName = input.projectName ?? (() => '');

  const metaOf = (conversationId: string, projectId?: string): DailySessionMeta => {
    const found = session(conversationId);
    return {
      ...(found.title ? { title: found.title } : {}),
      projectName: found.projectName ?? (projectId ? projectName(projectId) : ''),
    };
  };

  const live = day === dayKey(input.now);
  const results = input.results.filter((record) => within(record.at) && columnOf(record.kind));

  // 每个会话当天只留一条终态：结果日志按时间升序覆盖，同一会话重跑多次也只留最后一次
  const terminal = new Map<string, Terminal>();
  for (const record of [...results].sort((left, right) => left.at - right.at)) {
    terminal.set(record.conversationId, { at: record.at, kind: record.kind, record });
  }
  // 兜底：结果日志里没有这个会话当天的记录（旧版本没写 daily.jsonl），用派发记录的 lastResult
  for (const record of input.dispatched) {
    const last = record.lastResult;
    if (!last || !within(last.at) || terminal.has(record.conversationId)) continue;
    if (!columnOf(last.kind)) continue;
    terminal.set(record.conversationId, { at: last.at, kind: last.kind });
  }

  const sessionCard = (
    conversationId: string,
    projectId: string | undefined,
    at: number,
    result: Terminal | undefined,
    dispatchedAt: number | undefined,
    goal: string | undefined
  ): SecretaryDailyItem => {
    const meta = metaOf(conversationId, projectId);
    const record = result?.record;
    const label = result ? RESULT_LABEL[result.kind] : undefined;
    const summary = record ? summarize(record.text) : undefined;
    return {
      id: `session:${conversationId}`,
      at,
      title: record?.title || meta.title || goal || conversationId,
      ...(meta.projectName ? { projectName: meta.projectName } : {}),
      ...(label ? { label } : {}),
      ...(summary ? { summary } : {}),
      ...(record?.text ? { detail: record.text } : {}),
      ...(record?.branch ? { branch: record.branch } : {}),
      ...(record?.commit ? { commit: record.commit } : {}),
      ...(dispatchedAt !== undefined ? { dispatchedAt } : {}),
      conversationId,
    };
  };

  // 一张卡只在一列：按当天最终状态归列，派出时间退到卡片上显示
  const columns: Record<'running' | 'needsYou' | 'done' | 'failed', SecretaryDailyItem[]> = {
    running: [],
    needsYou: [],
    done: [],
    failed: [],
  };
  const placed = new Set<string>();
  // 已经标了遗留任务的会话不算在跑：残留的 running 与后台任务都不能把它挂在进行中
  const runningNow = (record: DispatchRecord): boolean =>
    record.leftoverTasks === undefined &&
    (record.lastState === 'running' || record.backgroundRunning === true);
  const dispatchedToday = input.dispatched.filter(
    (record) => !record.takeover && within(record.createdAt)
  );

  for (const record of input.dispatched) {
    const result = terminal.get(record.conversationId);
    const running = live && runningNow(record);
    // 接管会话不是派出去的：只有当天有终态、或今天还在跑时才上板
    if (record.takeover && !result && !running) continue;
    if (!result && !within(record.createdAt)) continue;
    placed.add(record.conversationId);
    const goal = record.goal?.split('\n')[0]?.trim();
    const card: SecretaryDailyItem = {
      ...sessionCard(
        record.conversationId,
        record.projectId,
        result?.at ?? record.createdAt,
        result,
        record.createdAt,
        goal
      ),
      tracked: true,
      ...(record.lastResult?.manual ? { manual: true as const } : {}),
    };
    // 当天没有终态结果时：真在跑、或从来没报过结果的才进「进行中」。
    // 报过结果、这一轮又没给新结果的会话，活已经干完，不能一直挂在进行中。
    const column = result
      ? columnOf(result.kind)
      : running || record.lastResult === undefined
        ? 'running'
        : 'done';
    // 已完成但还有没结束的后台任务：卡片标出来，并给一个停止遗留任务的操作
    if (column === 'done' && record.leftoverTasks)
      card.leftover = { count: record.leftoverTasks.count };
    // 还在跑但带着常驻服务：和「正在跑」区分开
    if (column === 'running' && record.backgroundPersistent) card.persistent = true;
    if (column) columns[column].push(card);
  }
  // 没有派发记录、但当天有结果的会话（记录被清理或不属于本机派发）也要上板
  for (const [conversationId, result] of terminal) {
    if (placed.has(conversationId)) continue;
    const column = columnOf(result.kind);
    if (!column) continue;
    columns[column].push(
      sessionCard(conversationId, result.record?.projectId, result.at, result, undefined, undefined)
    );
  }
  for (const items of Object.values(columns)) items.sort(newestFirst);

  // 待办按 id 合并：同一条待办当天只出一张卡，新增与完成时间都挂在卡上
  const todoItems: SecretaryDailyItem[] = [];
  for (const todo of input.todos) {
    const added = within(todo.createdAt) ? todo.createdAt : undefined;
    const done = within(todo.doneAt) ? todo.doneAt : undefined;
    // 状态时间取最近一次：完成了是完成时间，只新增是新增时间
    const at = done ?? added;
    if (at === undefined) continue;
    todoItems.push({
      id: `todo:${todo.id}`,
      at,
      title: todo.text,
      ...(added !== undefined ? { addedAt: added } : {}),
      ...(done !== undefined ? { doneAt: done } : {}),
      label: done !== undefined ? 'Done' : 'Added',
    });
  }
  const todos = todoItems.sort(newestFirst);

  // 同一操作作用在同一对象上只出一张卡：提案的提交与确认、同一天重复保存都算一次变更
  const changeByKey = new Map<string, SecretaryDailyItem>();
  for (const entry of input.audit) {
    if (!entry.ok || CHANGE_LABEL[entry.op] === undefined || !within(entry.at)) continue;
    const target = entry.targetId;
    const takeover = entry.op.startsWith('takeover_');
    const meta = takeover && target ? metaOf(target) : undefined;
    const key = `${entry.op}:${target ?? ''}`;
    // 审计按时间追加，同一键留最后一次
    const previous = changeByKey.get(key);
    if (previous && previous.at > entry.at) continue;
    changeByKey.set(key, {
      id: `audit:${key}`,
      at: entry.at,
      title: meta?.title || (takeover && target ? target : ''),
      ...(meta?.projectName ? { projectName: meta.projectName } : {}),
      label: CHANGE_LABEL[entry.op],
      ...(takeover && target ? { conversationId: target } : {}),
    });
  }
  const changes = [...changeByKey.values()].sort(newestFirst);

  const groups = (
    [
      { key: 'running', items: columns.running },
      { key: 'needsYou', items: columns.needsYou },
      { key: 'done', items: columns.done },
      { key: 'failed', items: columns.failed },
      { key: 'todos', items: todos },
      { key: 'changes', items: changes },
    ] as SecretaryDailyGroup[]
  ).filter((group) => group.items.length > 0);

  return {
    day,
    today: day === dayKey(input.now),
    counts: {
      dispatched: dispatchedToday.length,
      completed: columns.done.length,
      failed: columns.failed.length,
      needsYou: columns.needsYou.length,
      todosDone: todos.filter((item) => item.doneAt !== undefined).length,
      merged: results.filter((record) => record.merged).length,
    },
    groups,
    ...(input.earliest ? { earliest: input.earliest } : {}),
    retentionDays: input.retentionDays ?? DAILY_RETENTION_DAYS,
  };
}
