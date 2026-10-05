import { type CronSchedule, missedRuns, nextRun, parseCron } from '../../../shared/bots/cron';
import {
  type BotChat,
  type BotProfile,
  type BotRoutine,
  type BotRoutineBlock,
  type BotRoutineResult,
  type BotRoutineRun,
  type BotRoutineTrigger,
  isRoutineApproved,
  routineDeliveryId,
  routineExecutor,
} from '../../../shared/types/bot';
import type { BotEvent } from '../../../shared/types/botIpc';
import { BOT_BUDGET_ERROR } from '../../../shared/usage/botUsage';
import { delegationPolicy } from './delegationPolicy';
import type { BotRoutineRunLog } from './routineRuns';
import type { BotRoutineStore } from './routineStore';

export interface RoutineRunResult {
  ok: boolean;
  error?: string;
  conversationId?: string;
}
export interface RoutineRunOptions {
  deliveryId: string;
  executorId: string;
  dryRun: boolean;
}

interface Deps {
  store: Pick<BotRoutineStore, 'listAll' | 'markRun' | 'advance' | 'block'>;
  runs: Pick<BotRoutineRunLog, 'save' | 'get' | 'unsettled'>;
  /** 归属成员可用；否则不调度也不手动运行（成员归档 = 例行任务暂停） */
  eligible: (routine: BotRoutine) => boolean;
  /** 运行前依赖检查：执行成员、目标聊天、成员在群、委派 ACL */
  check: (routine: BotRoutine) => BotRoutineBlock | undefined;
  run: (routine: BotRoutine, options: RoutineRunOptions) => Promise<RoutineRunResult>;
  emit: (event: BotEvent) => void;
}

export type RoutineTriggerResult =
  | { ok: true; done: Promise<RoutineRunResult> }
  | { ok: false; error: string; reason?: BotRoutineBlock };

const DAY_MS = 86_400_000;

/** (since, now] 内最近的一个触发时刻；先在近 8 天里找，避免高频 cron 长时间关闭后逐个遍历 */
function latestSlot(cron: CronSchedule, since: number, now: number): number | undefined {
  for (const from of [Math.max(since, now - 8 * DAY_MS), since]) {
    let latest: number | undefined;
    for (let t = nextRun(cron, from); t !== undefined && t <= now; t = nextRun(cron, t)) latest = t;
    if (latest !== undefined) return latest;
  }
  return undefined;
}

const outcome = (result: RoutineRunResult): BotRoutineResult =>
  result.ok ? 'ok' : result.error === BOT_BUDGET_ERROR ? 'budget' : 'error';

/** 运行前依赖检查；doneBy 须满足归属成员 → 执行成员的委派 ACL */
export function routineBlock(
  routine: BotRoutine,
  lookup: {
    bot: (id: string) => BotProfile | undefined;
    chat: (id: string) => BotChat | undefined;
  }
): BotRoutineBlock | undefined {
  const executorId = routineExecutor(routine);
  const executor = lookup.bot(executorId);
  if (!executor) return 'executor-missing';
  if (executor.archivedAt !== undefined) return 'executor-archived';
  const chat = lookup.chat(routine.chatId);
  if (!chat) return 'chat-missing';
  if (chat.archivedAt !== undefined) return 'chat-archived';
  if (!chat.members.includes(executorId)) return 'not-in-chat';
  if (executorId === routine.botId) return undefined;
  const owner = lookup.bot(routine.botId);
  return owner && !delegationPolicy(owner, executor, 1, 0) ? undefined : 'acl';
}

/**
 * 单 timer 驱动；按 (routineId, scheduledFor) 在运行历史里持久化占用：
 * 同一时刻只跑一次，上一次未结算时到点记 skipped-busy，启动时把未结算的标 interrupted。
 */
export class RoutineScheduler {
  private timer?: ReturnType<typeof setTimeout>;
  private enabled = false;
  private due = new Map<string, number>();
  private running = new Set<string>();
  constructor(private readonly deps: Deps) {}

  start(): void {
    if (this.enabled) return;
    this.enabled = true;
    let changed = false;
    for (const run of this.deps.runs.unsettled()) {
      if (this.running.has(run.routineId)) continue;
      this.deps.runs.save({ ...run, result: 'interrupted', finishedAt: Date.now() });
      if (run.trigger !== 'dry-run')
        this.deps.store.markRun(run.botId, run.routineId, 'interrupted');
      changed = true;
    }
    const now = Date.now();
    for (const routine of this.deps.store.listAll()) {
      const cron = parseCron(routine.schedule);
      if (!cron || !this.schedulable(routine)) continue;
      const since = routine.cursor ?? routine.lastRunAt ?? routine.createdAt;
      const missed = missedRuns(cron, since, now);
      const latest = missed ? latestSlot(cron, since, now) : undefined;
      if (latest === undefined) continue;
      changed = true;
      if (!routine.catchUp) {
        this.deps.store.advance(routine.botId, routine.id, latest, missed);
        continue;
      }
      this.deps.store.advance(routine.botId, routine.id, latest, missed - 1);
      void this.fire(routine, latest, 'catchup');
    }
    if (changed) this.deps.emit({ kind: 'routine' });
    this.refresh();
  }

  stop(): void {
    this.enabled = false;
    clearTimeout(this.timer);
    this.timer = undefined;
    this.due.clear();
  }

  refresh(): void {
    clearTimeout(this.timer);
    this.due.clear();
    if (!this.enabled) return;
    for (const routine of this.deps.store.listAll()) {
      if (!this.schedulable(routine)) continue;
      const cron = parseCron(routine.schedule);
      const next = cron && nextRun(cron, Math.max(Date.now(), routine.cursor ?? 0));
      if (next !== undefined) this.due.set(routine.id, next);
    }
    this.arm();
  }

  /** 用户保存 / 批准后：启用中的例程立即做一次依赖检查，不满足即 blocked */
  verify(botId: string, id: string): BotRoutine | undefined {
    const routine = this.find(botId, id);
    if (routine?.status !== 'enabled') return routine;
    const block = this.deps.check(routine);
    return block ? this.deps.store.block(botId, id, block) : routine;
  }

  /** 手动运行 / 试运行：同步预检，通过后返回运行中的 Promise */
  trigger(botId: string, id: string, mode: 'manual' | 'dry-run'): RoutineTriggerResult {
    if (!this.enabled) return { ok: false, error: 'disabled' };
    const routine = this.find(botId, id);
    if (!routine) return { ok: false, error: 'not-found' };
    if (!this.deps.eligible(routine)) return { ok: false, error: 'unavailable' };
    if (mode === 'manual') {
      if (!isRoutineApproved(routine)) return { ok: false, error: 'not-approved' };
      if (routine.status === 'blocked') return { ok: false, error: 'blocked' };
    }
    const at = Date.now();
    if (this.running.has(routine.id) || this.deps.runs.get(botId, routineDeliveryId(id, at)))
      return { ok: false, error: 'busy' };
    const block = this.deps.check(routine);
    if (block) {
      if (mode === 'manual') this.blocked(routine, at, 'manual', block);
      return { ok: false, error: 'blocked', reason: block };
    }
    return { ok: true, done: this.execute(routine, at, mode) };
  }

  private schedulable(routine: BotRoutine): boolean {
    return (
      routine.status === 'enabled' && isRoutineApproved(routine) && this.deps.eligible(routine)
    );
  }

  private find(botId: string, id: string): BotRoutine | undefined {
    return this.deps.store.listAll().find((item) => item.id === id && item.botId === botId);
  }

  /** 调度时刻到点（含补跑）：已占用的跳过，依赖不满足即阻塞，上一次未结束记 skipped-busy */
  private async fire(
    routine: BotRoutine,
    scheduledFor: number,
    trigger: 'scheduled' | 'catchup'
  ): Promise<void> {
    const { botId, id } = routine;
    if (trigger === 'scheduled') this.deps.store.advance(botId, id, scheduledFor, 0);
    if (this.deps.runs.get(botId, routineDeliveryId(id, scheduledFor))) return;
    const block = this.deps.check(routine);
    if (block) {
      this.blocked(routine, scheduledFor, trigger, block);
      this.refresh();
      return;
    }
    if (this.running.has(id)) {
      this.record(routine, scheduledFor, trigger, { result: 'skipped-busy' });
      this.deps.emit({ kind: 'routine' });
      return;
    }
    await this.execute(routine, scheduledFor, trigger);
  }

  private async execute(
    routine: BotRoutine,
    scheduledFor: number,
    trigger: BotRoutineTrigger
  ): Promise<RoutineRunResult> {
    const dryRun = trigger === 'dry-run';
    const claim = this.record(routine, scheduledFor, trigger);
    this.running.add(routine.id);
    this.deps.emit({ kind: 'routine' });
    let result: RoutineRunResult;
    try {
      result = await this.deps.run(routine, {
        deliveryId: claim.runId,
        executorId: claim.executorId,
        dryRun,
      });
    } catch (error) {
      result = { ok: false, error: String(error) };
    }
    this.running.delete(routine.id);
    const settled: BotRoutineRun = { ...claim, result: outcome(result), finishedAt: Date.now() };
    if (result.conversationId) settled.conversationId = result.conversationId;
    if (!result.ok && result.error) settled.error = result.error;
    this.deps.runs.save(settled);
    if (!dryRun) this.deps.store.markRun(routine.botId, routine.id, outcome(result));
    this.deps.emit({ kind: 'routine' });
    return result;
  }

  private blocked(
    routine: BotRoutine,
    scheduledFor: number,
    trigger: BotRoutineTrigger,
    block: BotRoutineBlock
  ): void {
    this.record(routine, scheduledFor, trigger, { result: 'blocked', error: block });
    this.deps.store.block(routine.botId, routine.id, block);
    this.deps.emit({ kind: 'routine' });
  }

  private record(
    routine: BotRoutine,
    scheduledFor: number,
    trigger: BotRoutineTrigger,
    settled?: Pick<BotRoutineRun, 'result' | 'error'>
  ): BotRoutineRun {
    const now = Date.now();
    const run: BotRoutineRun = {
      runId: routineDeliveryId(routine.id, scheduledFor),
      routineId: routine.id,
      botId: routine.botId,
      executorId: routineExecutor(routine),
      chatId: routine.chatId,
      trigger,
      scheduledFor,
      startedAt: now,
      ...(settled ? { ...settled, finishedAt: now } : {}),
    };
    this.deps.runs.save(run);
    return run;
  }

  private arm(): void {
    if (!this.enabled || !this.due.size) return;
    const delay = Math.max(0, Math.min(...this.due.values()) - Date.now());
    this.timer = setTimeout(
      () => {
        for (const routine of this.deps.store.listAll()) {
          const at = this.due.get(routine.id);
          if (at !== undefined && at <= Date.now() && this.schedulable(routine))
            void this.fire(routine, at, 'scheduled');
        }
        this.refresh();
      },
      Math.min(delay, 2_147_483_647)
    );
    this.timer.unref?.();
  }
}
