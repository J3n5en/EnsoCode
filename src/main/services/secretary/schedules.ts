import { randomUUID } from 'node:crypto';
import { nextRun, parseCron } from '@shared/bots/cron';
import { parseScheduleText } from '@shared/bots/routineSchedule';
import type {
  SecretaryAuditEntry,
  SecretaryProfile,
  SecretarySchedule,
  SecretaryScheduleView,
  SecretaryTodo,
  SecretaryUpdate,
} from '@shared/types/secretary';
import { appendAudit } from './audit';
import { notifySecretaryChanged } from './dispatch';
import { followDepsFor, recordPhoneFollow } from './following';
import type { SecretaryContext } from './secretaries';
import { SecretaryStore } from './store';
import type { SecretaryOpContext, SecretaryOpHandler, SecretaryOpResult } from './tools';

const CLOCK_RE = /^([01]\d|2[0-3]):([0-5]\d)$/u;

export const DAILY_BRIEF_ID = 'system:daily-brief';
const DAILY_BRIEF_PROMPT =
  '每日简报：汇总各项目会话的进展、需要我处理的事项和今天的待办，用要点告诉我。';

export function todoReminderId(todoId: string): string {
  return `system:todo:${todoId}`;
}

/** 定时读写与审计；测试注入假实现，生产走文件末尾的 secretarySchedulePorts */
export interface SchedulePorts {
  schedules(): SecretarySchedule[];
  saveSchedules(schedules: SecretarySchedule[]): void;
  audit(entry: SecretaryAuditEntry): void;
  newId(): string;
  now(): number;
  /** 定时写盘后通知面板重读 */
  publish(): void;
  /** 手机发起的回合里加的定时记进「手机关注」；缺省表示不记 */
  follow?(input: {
    targetId: string;
    summary: string;
    secretaryConversationId: string | null;
  }): void;
}

/** 系统定时重算只需要读写与时钟，回传宿主不必带审计与 id 生成 */
export type SyncSchedulePorts = Pick<
  SchedulePorts,
  'schedules' | 'saveSchedules' | 'now' | 'publish'
>;

function cronOf(schedule: SecretarySchedule): ReturnType<typeof parseCron> {
  return 'cron' in schedule && schedule.cron ? parseCron(schedule.cron) : undefined;
}

/** 一次性按 at，cron 按 lastFiredAt（没有则创建时间）之后的下一次 */
export function nextRunAt(schedule: SecretarySchedule): number | undefined {
  if ('at' in schedule && schedule.at) {
    const time = Date.parse(schedule.at);
    return Number.isNaN(time) ? undefined : time;
  }
  const cron = cronOf(schedule);
  if (!cron) return undefined;
  return nextRun(cron, schedule.lastFiredAt ?? schedule.createdAt);
}

function scheduleUpdate(schedule: SecretarySchedule, now: number): SecretaryUpdate {
  return {
    key: `schedule:${schedule.id}:${now}`,
    at: now,
    kind: 'schedule',
    scheduleId: schedule.id,
    text: `${schedule.name}：${schedule.prompt}`,
  };
}

export interface ScheduleFire {
  schedules: SecretarySchedule[];
  updates: SecretaryUpdate[];
  changed: boolean;
}

/** 到点触发：一次性投完删除，cron 只投一次并把 lastFiredAt 推到 now，错过的多次不补发 */
export function fireDue(schedules: readonly SecretarySchedule[], now: number): ScheduleFire {
  const kept: SecretarySchedule[] = [];
  const updates: SecretaryUpdate[] = [];
  for (const schedule of schedules) {
    const due = nextRunAt(schedule);
    if (due === undefined || due > now) {
      kept.push(schedule);
      continue;
    }
    updates.push(scheduleUpdate(schedule, now));
    if (cronOf(schedule)) kept.push({ ...schedule, lastFiredAt: now });
  }
  return { schedules: kept, updates, changed: updates.length > 0 };
}

/** 应用未运行期间错过的 cron 只算下一次：把 lastFiredAt 推到 now，不投递 */
export function skipMissedCron(
  schedules: readonly SecretarySchedule[],
  now: number
): { schedules: SecretarySchedule[]; changed: boolean } {
  let changed = false;
  const next = schedules.map((schedule) => {
    const due = nextRunAt(schedule);
    if (!cronOf(schedule) || due === undefined || due > now) return schedule;
    changed = true;
    return { ...schedule, lastFiredAt: now };
  });
  return { schedules: next, changed };
}

export function scheduleView(schedule: SecretarySchedule): SecretaryScheduleView {
  const view: SecretaryScheduleView = {
    id: schedule.id,
    name: schedule.name,
    prompt: schedule.prompt,
  };
  if ('at' in schedule && schedule.at) view.at = schedule.at;
  if ('cron' in schedule && schedule.cron) view.cron = schedule.cron;
  const next = nextRunAt(schedule);
  if (next !== undefined) view.nextRunAt = next;
  if (schedule.lastFiredAt !== undefined) view.lastFiredAt = schedule.lastFiredAt;
  if (schedule.system) view.system = schedule.system;
  return view;
}

export function listSchedules(ports: SchedulePorts): SecretaryScheduleView[] {
  return ports.schedules().map(scheduleView);
}

function systemKey(system: SecretarySchedule['system']): string {
  if (!system) return '';
  return typeof system === 'string' ? system : system.todoId;
}

function sameSchedule(left: SecretarySchedule, right: SecretarySchedule): boolean {
  return (
    left.id === right.id &&
    left.name === right.name &&
    left.prompt === right.prompt &&
    left.createdAt === right.createdAt &&
    left.lastFiredAt === right.lastFiredAt &&
    ('at' in left ? left.at : undefined) === ('at' in right ? right.at : undefined) &&
    ('cron' in left ? left.cron : undefined) === ('cron' in right ? right.cron : undefined) &&
    systemKey(left.system) === systemKey(right.system)
  );
}

/**
 * 系统定时是档案与待办的派生状态：每日简报跟 dailyBriefAt，待办提醒跟未完成待办的到期时间。
 * 用户自己建的定时原样保留；重算结果没变就不写盘。
 */
export function syncSystemSchedules(
  ports: SyncSchedulePorts,
  profile: SecretaryProfile | null,
  todos: readonly SecretaryTodo[]
): SecretarySchedule[] {
  const current = ports.schedules();
  const now = ports.now();
  const previous = new Map(
    current.filter((schedule) => schedule.system).map((schedule) => [schedule.id, schedule])
  );
  const desired = current.filter((schedule) => !schedule.system);

  const clock = profile?.dailyBriefAt ? CLOCK_RE.exec(profile.dailyBriefAt) : null;
  if (clock) {
    const before = previous.get(DAILY_BRIEF_ID);
    desired.push({
      id: DAILY_BRIEF_ID,
      name: '每日简报',
      prompt: DAILY_BRIEF_PROMPT,
      createdAt: before?.createdAt ?? now,
      cron: `${Number(clock[2])} ${Number(clock[1])} * * *`,
      ...(before?.lastFiredAt !== undefined ? { lastFiredAt: before.lastFiredAt } : {}),
      system: 'daily-brief',
    });
  }

  for (const todo of todos) {
    // 已经到期或已完成的待办不再提醒
    if (todo.doneAt !== undefined || todo.dueAt === undefined || todo.dueAt <= now) continue;
    const before = previous.get(todoReminderId(todo.id));
    desired.push({
      id: todoReminderId(todo.id),
      name: `待办提醒：${todo.text}`,
      prompt: `待办到期提醒：${todo.text}`,
      createdAt: before?.createdAt ?? now,
      at: new Date(todo.dueAt).toISOString(),
      ...(before?.lastFiredAt !== undefined ? { lastFiredAt: before.lastFiredAt } : {}),
      system: { todoId: todo.id },
    });
  }

  const unchanged =
    desired.length === current.length &&
    desired.every((schedule, index) => sameSchedule(schedule, current[index]));
  if (unchanged) return current;
  ports.saveSchedules(desired);
  ports.publish();
  return desired;
}

function stringParam(params: Record<string, unknown>, key: string): string | undefined {
  const value = params[key];
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function auditFailure(
  ports: SchedulePorts,
  ctx: SecretaryOpContext,
  op: string,
  error: string,
  targetId?: string
): SecretaryOpResult {
  ports.audit({
    at: ports.now(),
    secretaryConversationId: ctx.secretaryConversationId,
    op,
    ...(targetId ? { targetId } : {}),
    ok: false,
    detail: error,
  });
  return { ok: false, error };
}

const invalidArguments: SecretaryOpResult = { ok: false, error: 'invalid arguments' };

/** 系统定时由档案与待办派生，秘书删掉也会被重新生成，所以只允许删自己建的 */
export function removeSchedule(
  ports: SchedulePorts,
  scheduleId: string,
  ctx: SecretaryOpContext
): SecretaryOpResult {
  const schedules = ports.schedules();
  const target = schedules.find((schedule) => schedule.id === scheduleId);
  if (!target) return auditFailure(ports, ctx, 'schedule_remove', 'not-found', scheduleId);
  if (target.system)
    return auditFailure(ports, ctx, 'schedule_remove', 'system-schedule', scheduleId);
  ports.saveSchedules(schedules.filter((schedule) => schedule.id !== scheduleId));
  ports.publish();
  ports.audit({
    at: ports.now(),
    secretaryConversationId: ctx.secretaryConversationId,
    op: 'schedule_remove',
    targetId: scheduleId,
    ok: true,
  });
  return { ok: true, result: { scheduleId, name: target.name } };
}

export type SecretaryScheduleHandlers = Record<
  'schedule_add' | 'schedule_list' | 'schedule_remove',
  SecretaryOpHandler
>;

export function createSecretaryScheduleHandlers(ports: SchedulePorts): SecretaryScheduleHandlers {
  return {
    schedule_add(params, ctx) {
      const name = stringParam(params, 'name');
      const prompt = stringParam(params, 'prompt');
      if (!name || !prompt) return invalidArguments;
      const atRaw = stringParam(params, 'at');
      const cronRaw = stringParam(params, 'cron');
      if (Boolean(atRaw) === Boolean(cronRaw))
        return auditFailure(ports, ctx, 'schedule_add', 'exactly-one-of-at-or-cron');
      const now = ports.now();
      const id = ports.newId();
      let schedule: SecretarySchedule;
      if (atRaw) {
        const time = Date.parse(atRaw);
        if (Number.isNaN(time)) return auditFailure(ports, ctx, 'schedule_add', 'invalid-at');
        if (time <= now) return auditFailure(ports, ctx, 'schedule_add', 'at-in-past');
        schedule = { id, name, prompt, createdAt: now, at: new Date(time).toISOString() };
      } else {
        const cron = parseCron(cronRaw as string)?.source ?? parseScheduleText(cronRaw as string);
        const parsed = cron ? parseCron(cron) : undefined;
        if (!parsed || nextRun(parsed, now) === undefined)
          return auditFailure(ports, ctx, 'schedule_add', 'invalid-cron');
        schedule = { id, name, prompt, createdAt: now, cron: parsed.source };
      }
      ports.saveSchedules([...ports.schedules(), schedule]);
      ports.publish();
      // 手机发起的回合里加的定时：到点推一次手机，推完结束关注
      ports.follow?.({
        targetId: id,
        summary: name,
        secretaryConversationId: ctx.secretaryConversationId,
      });
      ports.audit({
        at: now,
        secretaryConversationId: ctx.secretaryConversationId,
        op: 'schedule_add',
        targetId: id,
        ok: true,
      });
      const next = nextRunAt(schedule);
      return {
        ok: true,
        result: { scheduleId: id, ...(next !== undefined ? { nextRunAt: next } : {}) },
      };
    },

    schedule_list() {
      return { ok: true, result: { schedules: listSchedules(ports) } };
    },

    schedule_remove(params, ctx) {
      const scheduleId = stringParam(params, 'scheduleId');
      if (!scheduleId) return invalidArguments;
      return removeSchedule(ports, scheduleId, ctx);
    },
  };
}

export function schedulePortsFor(ctx: SecretaryContext): SchedulePorts {
  const store = () => new SecretaryStore(ctx.dir);
  return {
    schedules: () => store().schedules(),
    saveSchedules: (schedules) => {
      store().saveSchedules(schedules);
    },
    audit: (entry) => appendAudit(ctx.dir, entry),
    newId: () => randomUUID(),
    now: () => Date.now(),
    publish: () => notifySecretaryChanged(),
    follow: (input) => {
      recordPhoneFollow(
        {
          kind: 'schedule',
          targetId: input.targetId,
          summary: input.summary,
          secretaryConversationId: input.secretaryConversationId,
        },
        followDepsFor(ctx.dir)
      );
    },
  };
}

export function scheduleHandlersFor(ctx: SecretaryContext): SecretaryScheduleHandlers {
  return createSecretaryScheduleHandlers(schedulePortsFor(ctx));
}
