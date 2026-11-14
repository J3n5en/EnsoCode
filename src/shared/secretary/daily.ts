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

/** 同一会话同一类结果只留最新一条：一天里重跑多次不该刷屏 */
function dedupe(items: readonly SecretaryDailyItem[]): SecretaryDailyItem[] {
  const seen = new Map<string, SecretaryDailyItem>();
  for (const item of items) {
    const key = `${item.conversationId ?? item.id}|${item.label ?? ''}`;
    const previous = seen.get(key);
    if (!previous || previous.at < item.at) seen.set(key, item);
  }
  return [...seen.values()].sort(newestFirst);
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

  const resultItem = (record: SecretaryDailyRecord): SecretaryDailyItem => {
    const meta = metaOf(record.conversationId, record.projectId);
    const label = RESULT_LABEL[record.kind];
    const summary = summarize(record.text);
    return {
      id: `result:${record.conversationId}:${record.kind}:${record.at}`,
      at: record.at,
      title: record.title || meta.title || record.conversationId,
      ...(meta.projectName ? { projectName: meta.projectName } : {}),
      ...(label ? { label } : {}),
      ...(summary ? { summary } : {}),
      ...(record.text ? { detail: record.text } : {}),
      ...(record.branch ? { branch: record.branch } : {}),
      ...(record.commit ? { commit: record.commit } : {}),
      conversationId: record.conversationId,
    };
  };

  const results = input.results.filter((record) => within(record.at));
  const done = dedupe(results.filter((record) => DONE_KINDS.has(record.kind)).map(resultItem));
  const failed = dedupe(results.filter((record) => FAILED_KINDS.has(record.kind)).map(resultItem));
  const needsYou = dedupe(
    results.filter((record) => NEEDS_YOU_KINDS.has(record.kind)).map(resultItem)
  );

  const dispatchItem = (record: DispatchRecord): SecretaryDailyItem => {
    const meta = metaOf(record.conversationId, record.projectId);
    const goal = record.goal?.split('\n')[0]?.trim();
    return {
      id: `dispatch:${record.conversationId}`,
      at: record.createdAt,
      title: meta.title || goal || record.conversationId,
      ...(meta.projectName ? { projectName: meta.projectName } : {}),
      conversationId: record.conversationId,
    };
  };
  // 「进行中」读的是实时状态（lastState / 后台任务），只有今天成立；历史日期不猜当时在跑什么
  const live = day === dayKey(input.now);
  const runningNow = (record: DispatchRecord): boolean =>
    record.lastState === 'running' || record.backgroundRunning === true;
  const dispatchedRecords = input.dispatched.filter(
    (record) => !record.takeover && within(record.createdAt)
  );
  const running = live
    ? dispatchedRecords.filter(runningNow).map(dispatchItem).sort(newestFirst)
    : [];
  const dispatched = dispatchedRecords
    .filter((record) => !(live && runningNow(record)))
    .map(dispatchItem)
    .sort(newestFirst);

  const todoItems: SecretaryDailyItem[] = [];
  for (const todo of input.todos) {
    if (within(todo.createdAt))
      todoItems.push({
        id: `todo:${todo.id}:add`,
        at: todo.createdAt,
        title: todo.text,
        label: 'Added',
      });
    if (within(todo.doneAt))
      todoItems.push({
        id: `todo:${todo.id}:done`,
        at: todo.doneAt,
        title: todo.text,
        label: 'Done',
      });
  }
  const todos = todoItems.sort(newestFirst);

  const changes = input.audit
    .filter((entry) => entry.ok && CHANGE_LABEL[entry.op] !== undefined && within(entry.at))
    .map((entry): SecretaryDailyItem => {
      const target = entry.targetId;
      const takeover = entry.op.startsWith('takeover_');
      const meta = takeover && target ? metaOf(target) : undefined;
      return {
        id: `audit:${entry.op}:${target ?? ''}:${entry.at}`,
        at: entry.at,
        title: meta?.title || (takeover && target ? target : ''),
        ...(meta?.projectName ? { projectName: meta.projectName } : {}),
        label: CHANGE_LABEL[entry.op],
        ...(takeover && target ? { conversationId: target } : {}),
      };
    })
    .sort(newestFirst);

  const groups = (
    [
      { key: 'done', items: done },
      { key: 'failed', items: failed },
      { key: 'needsYou', items: needsYou },
      { key: 'dispatched', items: dispatched },
      { key: 'running', items: running },
      { key: 'todos', items: todos },
      { key: 'changes', items: changes },
    ] as SecretaryDailyGroup[]
  ).filter((group) => group.items.length > 0);

  return {
    day,
    today: day === dayKey(input.now),
    counts: {
      dispatched: dispatchedRecords.length,
      completed: done.length,
      failed: failed.length,
      needsYou: needsYou.length,
      todosDone: todos.filter((item) => item.label === 'Done').length,
      merged: results.filter((record) => record.merged).length,
    },
    groups,
    ...(input.earliest ? { earliest: input.earliest } : {}),
    retentionDays: input.retentionDays ?? DAILY_RETENTION_DAYS,
  };
}
