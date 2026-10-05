import { randomUUID } from 'node:crypto';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { MISSED_RUNS_MAX, parseCron } from '../../../shared/bots/cron';
import { migrateRecord, withSchemaVersion } from '../../../shared/bots/migrations';
import {
  type BotRoutine,
  type BotRoutineBlock,
  type BotRoutineResult,
  botNameKey,
  isBotChatId,
  isBotId,
  isRoutineApproved,
  parseBotRoutine,
} from '../../../shared/types/bot';
import { readJson, writeJsonAtomic } from './files';

export interface BotRoutineDraft {
  /** 缺省新建；给定则更新已有条目 */
  id?: string;
  title: string;
  prompt: string;
  schedule: string;
  chatId: string;
  enabled?: boolean;
  /** null 清除（由归属成员自己执行） */
  doneBy?: string | null;
  catchUp?: boolean;
}

export type BotRoutineWriteResult =
  | { ok: true; routine: BotRoutine }
  | { ok: false; reason: 'invalid' | 'not-found' };
export type BotRoutineProposeResult =
  | { ok: true; routine: BotRoutine; created: boolean; unchanged?: true }
  | { ok: false; reason: 'invalid' };
export type BotRoutineReviewResult =
  | { ok: true; routine: BotRoutine }
  | { ok: true; removed: true }
  | { ok: false; reason: 'invalid' | 'not-found' };

type Procedure = Pick<BotRoutine, 'title' | 'prompt' | 'schedule' | 'chatId' | 'doneBy'>;
const PROCEDURE_KEYS = ['title', 'prompt', 'schedule', 'chatId', 'doneBy'] as const;
const sameProcedure = (a: Procedure, b: Procedure) =>
  PROCEDURE_KEYS.every((key) => a[key] === b[key]);

/**
 * userData/bots/<botId>/routines.json；每次读盘，路径只由 botId（uuid）推导。
 * save = 用户新建 / 编辑（即批准当前版本）；propose = 成员提议 / 改动（回到待批准）。
 */
export class BotRoutineStore {
  constructor(
    private readonly root: string,
    private readonly now: () => number = Date.now
  ) {}

  list(botId: string): BotRoutine[] {
    if (!isBotId(botId)) return [];
    const raw = migrateRecord('routines', readJson(this.file(botId)));
    const items =
      raw && typeof raw === 'object' && Array.isArray((raw as { routines?: unknown }).routines)
        ? ((raw as { routines: unknown[] }).routines as unknown[])
        : [];
    return items
      .map(parseBotRoutine)
      .filter((routine): routine is BotRoutine => routine?.botId === botId);
  }

  listAll(): BotRoutine[] {
    let names: string[] = [];
    try {
      names = readdirSync(this.root);
    } catch {
      return [];
    }
    return names.filter(isBotId).flatMap((botId) => this.list(botId));
  }

  save(botId: string, draft: BotRoutineDraft): BotRoutineWriteResult {
    const procedure = this.procedure(botId, draft);
    if (!procedure) return { ok: false, reason: 'invalid' };
    const routines = this.list(botId);
    const now = this.now();
    if (draft.id === undefined) {
      const routine: BotRoutine = {
        id: randomUUID(),
        botId,
        ...procedure,
        status: draft.enabled === false ? 'paused' : 'enabled',
        procedureVersion: 1,
        approvedVersion: 1,
        catchUp: draft.catchUp ?? true,
        cursor: now,
        createdAt: now,
        updatedAt: now,
      };
      this.write(botId, [...routines, routine]);
      return { ok: true, routine };
    }
    const index = routines.findIndex((item) => item.id === draft.id);
    if (index < 0) return { ok: false, reason: 'not-found' };
    const previous = routines[index];
    const { blockedReason: _blocked, doneBy: _doneBy, ...rest } = previous;
    const procedureVersion = sameProcedure(previous, procedure)
      ? previous.procedureVersion
      : previous.procedureVersion + 1;
    const status =
      draft.enabled === false
        ? 'paused'
        : draft.enabled === true || previous.status !== 'paused'
          ? 'enabled'
          : 'paused';
    const routine: BotRoutine = {
      ...rest,
      ...procedure,
      status,
      procedureVersion,
      approvedVersion: procedureVersion,
      catchUp: draft.catchUp ?? previous.catchUp,
      updatedAt: now,
    };
    if (procedure.doneBy === undefined) delete routine.doneBy;
    // 重新启用或改调度后从现在起算，不补暂停 / 阻塞期间的时刻
    if (
      status === 'enabled' &&
      (previous.status !== 'enabled' || previous.schedule !== routine.schedule)
    )
      routine.cursor = now;
    routines[index] = routine;
    this.write(botId, routines);
    return { ok: true, routine };
  }

  /** 成员提议：同一聊天里同名（不分大小写）的视为改动；流程不变时不写盘 */
  propose(
    botId: string,
    draft: Omit<BotRoutineDraft, 'id' | 'enabled' | 'catchUp'>
  ): BotRoutineProposeResult {
    const procedure = this.procedure(botId, draft);
    if (!procedure) return { ok: false, reason: 'invalid' };
    const routines = this.list(botId);
    const now = this.now();
    const index = routines.findIndex(
      (item) =>
        item.chatId === procedure.chatId && botNameKey(item.title) === botNameKey(procedure.title)
    );
    if (index < 0) {
      const routine: BotRoutine = {
        id: randomUUID(),
        botId,
        ...procedure,
        status: 'draft',
        procedureVersion: 1,
        catchUp: true,
        proposedBy: botId,
        createdAt: now,
        updatedAt: now,
      };
      this.write(botId, [...routines, routine]);
      return { ok: true, routine, created: true };
    }
    const previous = routines[index];
    if (sameProcedure(previous, procedure))
      return { ok: true, routine: previous, created: false, unchanged: true };
    const { blockedReason: _blocked, doneBy: _doneBy, ...rest } = previous;
    const routine: BotRoutine = {
      ...rest,
      ...procedure,
      status: 'draft',
      procedureVersion: previous.procedureVersion + 1,
      proposedBy: botId,
      updatedAt: now,
    };
    if (procedure.doneBy === undefined) delete routine.doneBy;
    routines[index] = routine;
    this.write(botId, routines);
    return { ok: true, routine, created: false };
  }

  /** 用户审批待批准的版本：批准即启用；拒绝从未批准过的直接删除，否则暂停 */
  review(botId: string, id: string, approve: boolean): BotRoutineReviewResult {
    const routines = this.list(botId);
    const index = routines.findIndex((item) => item.id === id);
    if (index < 0) return { ok: false, reason: 'not-found' };
    const previous = routines[index];
    if (isRoutineApproved(previous)) return { ok: false, reason: 'invalid' };
    if (!approve && previous.approvedVersion === undefined) {
      this.write(
        botId,
        routines.filter((item) => item.id !== id)
      );
      return { ok: true, removed: true };
    }
    const { blockedReason: _blocked, ...rest } = previous;
    const now = this.now();
    const routine: BotRoutine = approve
      ? {
          ...rest,
          status: 'enabled',
          approvedVersion: previous.procedureVersion,
          cursor: now,
          updatedAt: now,
        }
      : { ...rest, status: 'paused', updatedAt: now };
    routines[index] = routine;
    this.write(botId, routines);
    return { ok: true, routine };
  }

  block(botId: string, id: string, reason: BotRoutineBlock): BotRoutine | undefined {
    return this.patch(botId, id, (routine) => ({
      ...routine,
      status: 'blocked',
      blockedReason: reason,
    }));
  }

  /** 游标只前移；给定 missed 时覆盖错过次数（0 清除） */
  advance(botId: string, id: string, cursor: number, missed?: number): BotRoutine | undefined {
    return this.patch(botId, id, (routine) => {
      const next: BotRoutine = { ...routine, cursor: Math.max(routine.cursor ?? 0, cursor) };
      if (missed !== undefined) {
        delete next.missed;
        if (missed > 0) next.missed = Math.min(MISSED_RUNS_MAX, Math.floor(missed));
      }
      return next;
    });
  }

  remove(botId: string, id: string): boolean {
    const routines = this.list(botId);
    const rest = routines.filter((item) => item.id !== id);
    if (rest.length === routines.length) return false;
    this.write(botId, rest);
    return true;
  }

  /** 给定 missed 时覆盖错过次数（截断到 99，0 清除），缺省保留 */
  markRun(
    botId: string,
    id: string,
    result: BotRoutineResult,
    missed?: number
  ): BotRoutine | undefined {
    return this.patch(botId, id, (previous) => {
      const routine: BotRoutine = { ...previous, lastRunAt: this.now(), lastResult: result };
      if (missed !== undefined) {
        delete routine.missed;
        if (missed > 0) routine.missed = Math.min(MISSED_RUNS_MAX, Math.floor(missed));
      }
      return routine;
    });
  }

  private patch(
    botId: string,
    id: string,
    update: (routine: BotRoutine) => BotRoutine
  ): BotRoutine | undefined {
    const routines = this.list(botId);
    const index = routines.findIndex((item) => item.id === id);
    if (index < 0) return undefined;
    const routine = update(routines[index]);
    routines[index] = routine;
    this.write(botId, routines);
    return routine;
  }

  private procedure(
    botId: string,
    draft: Omit<BotRoutineDraft, 'id' | 'enabled' | 'catchUp'>
  ): Procedure | undefined {
    const title = typeof draft.title === 'string' ? draft.title.trim() : '';
    const prompt = typeof draft.prompt === 'string' ? draft.prompt.trim() : '';
    const cron = typeof draft.schedule === 'string' ? parseCron(draft.schedule) : undefined;
    if (!isBotId(botId) || !title || !prompt || !cron || !isBotChatId(draft.chatId)) return;
    if (draft.doneBy !== undefined && draft.doneBy !== null && !isBotId(draft.doneBy)) return;
    const procedure: Procedure = { title, prompt, schedule: cron.source, chatId: draft.chatId };
    if (typeof draft.doneBy === 'string' && draft.doneBy !== botId) procedure.doneBy = draft.doneBy;
    return procedure;
  }

  private file(botId: string): string {
    return join(this.root, botId, 'routines.json');
  }

  private write(botId: string, routines: BotRoutine[]): void {
    writeJsonAtomic(this.file(botId), withSchemaVersion('routines', { routines }));
  }
}
