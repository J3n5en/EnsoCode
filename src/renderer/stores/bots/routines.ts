import { describeCron, nextRun, parseCron } from '@shared/bots/cron';
import type { BotChat, BotRoutine } from '@shared/types/bot';

/** 每天 9:00、工作日 9:00、每周一 9:00、每小时 */
export const ROUTINE_PRESETS = ['0 9 * * *', '0 9 * * 1-5', '0 9 * * 1', '0 * * * *'] as const;

export interface SchedulePreview {
  source: string;
  description: string;
  next: number | undefined;
}

export function schedulePreview(
  expr: string,
  lang: 'zh' | 'en',
  now: number
): SchedulePreview | undefined {
  const cron = parseCron(expr);
  if (!cron) return undefined;
  return { source: cron.source, description: describeCron(cron, lang), next: nextRun(cron, now) };
}

/** 例行任务可投递的聊天：该成员所在、未归档；私聊在前 */
export function routineTargets(chats: readonly BotChat[], botId: string): BotChat[] {
  return chats
    .filter((chat) => chat.archivedAt === undefined && chat.members.includes(botId))
    .sort((a, b) => Number(a.kind === 'group') - Number(b.kind === 'group'));
}

export type RoutineDraftIssue = 'title' | 'prompt' | 'schedule' | 'chat';

export function routineDraftIssue(draft: {
  title: string;
  prompt: string;
  schedule: string;
  chatId: string;
}): RoutineDraftIssue | null {
  if (!draft.title.trim()) return 'title';
  if (!draft.prompt.trim()) return 'prompt';
  if (!parseCron(draft.schedule)) return 'schedule';
  if (!draft.chatId) return 'chat';
  return null;
}

export interface RoutineAlert {
  kind: 'approval' | 'blocked';
  routine: BotRoutine;
}
