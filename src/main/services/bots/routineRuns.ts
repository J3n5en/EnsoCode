import { appendFileSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { type BotRoutineRun, isBotId, parseBotRoutineRun } from '../../../shared/types/bot';
import { writeAtomic } from './files';

const COMPACT_LINES = 1000;
const KEEP_PER_ROUTINE = 50;

/** userData/bots/<botId>/routine-runs.jsonl：执行历史 + 占用（未结算的条目），同 runId 后写覆盖 */
export class BotRoutineRunLog {
  /** 每个成员文件的行数（首次写入时读一次），超过上限才压缩 */
  private readonly lines = new Map<string, number>();
  constructor(private readonly root: string) {}

  save(run: BotRoutineRun): void {
    const parsed = parseBotRoutineRun(run);
    if (!parsed) throw new Error('Invalid routine run');
    mkdirSync(join(this.root, parsed.botId), { recursive: true });
    appendFileSync(this.file(parsed.botId), `\n${JSON.stringify(parsed)}\n`, 'utf8');
    const lines = (this.lines.get(parsed.botId) ?? this.read(parsed.botId).lines - 1) + 1;
    this.lines.set(parsed.botId, lines);
    if (lines > COMPACT_LINES) this.compact(parsed.botId, this.read(parsed.botId).runs);
  }

  get(botId: string, runId: string): BotRoutineRun | undefined {
    return this.read(botId).runs.get(runId);
  }

  /** 最近在前 */
  list(botId: string, routineId: string, limit = 20): BotRoutineRun[] {
    return [...this.read(botId).runs.values()]
      .filter((run) => run.routineId === routineId)
      .sort((a, b) => b.startedAt - a.startedAt || b.scheduledFor - a.scheduledFor)
      .slice(0, limit);
  }

  unsettled(): BotRoutineRun[] {
    let names: string[] = [];
    try {
      names = readdirSync(this.root);
    } catch {
      return [];
    }
    return names
      .filter(isBotId)
      .flatMap((botId) => [...this.read(botId).runs.values()])
      .filter((run) => run.result === undefined);
  }

  forget(botId: string, routineId: string): void {
    const { runs } = this.read(botId);
    if (![...runs.values()].some((run) => run.routineId === routineId)) return;
    this.write(
      botId,
      [...runs.values()].filter((run) => run.routineId !== routineId)
    );
  }

  private compact(botId: string, runs: Map<string, BotRoutineRun>): void {
    const byRoutine = new Map<string, BotRoutineRun[]>();
    for (const run of runs.values())
      byRoutine.set(run.routineId, [...(byRoutine.get(run.routineId) ?? []), run]);
    const kept = [...byRoutine.values()].flatMap((items) => {
      const sorted = items.sort((a, b) => b.startedAt - a.startedAt);
      return sorted.filter((run, index) => index < KEEP_PER_ROUTINE || run.result === undefined);
    });
    this.write(botId, kept);
  }

  private write(botId: string, runs: BotRoutineRun[]): void {
    const ordered = [...runs].sort((a, b) => a.startedAt - b.startedAt);
    this.lines.set(botId, ordered.length);
    writeAtomic(this.file(botId), ordered.map((run) => `${JSON.stringify(run)}\n`).join(''));
  }

  private read(botId: string): { runs: Map<string, BotRoutineRun>; lines: number } {
    const runs = new Map<string, BotRoutineRun>();
    if (!isBotId(botId)) return { runs, lines: 0 };
    let text: string;
    try {
      text = readFileSync(this.file(botId), 'utf8');
    } catch {
      return { runs, lines: 0 };
    }
    let lines = 0;
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      lines += 1;
      try {
        const run = parseBotRoutineRun(JSON.parse(line));
        if (run) runs.set(run.runId, run);
      } catch {
        /* torn or invalid line */
      }
    }
    return { runs, lines };
  }

  private file(botId: string): string {
    return join(this.root, botId, 'routine-runs.jsonl');
  }
}
