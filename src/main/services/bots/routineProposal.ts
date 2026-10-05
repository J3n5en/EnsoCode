import { randomUUID } from 'node:crypto';
import { describeCron } from '../../../shared/bots/cron';
import { parseScheduleText } from '../../../shared/bots/routineSchedule';
import { type BotProfile, botNameKey, GROUP_TASK_TITLE_MAX } from '../../../shared/types/bot';
import type { BotEvent } from '../../../shared/types/botIpc';
import type { BotStore } from './botStore';
import type { BotChatStore } from './chatStore';
import { delegationPolicy } from './delegationPolicy';
import type { BotRoutineStore } from './routineStore';

const PROMPT_MAX = 4000;
const SCHEDULE_HINT =
  'Unrecognized schedule. Use 5-field cron (minute hour day month weekday, local time) or a phrase like "daily 09:00", "weekdays 18:30", "every Monday 10:00", "每天 9:00", "工作日 18:30", "每周一 10:00", "hourly".';

interface Deps {
  bots: Pick<BotStore, 'get' | 'list'>;
  chats: Pick<BotChatStore, 'get' | 'appendEntry'>;
  routines: Pick<BotRoutineStore, 'propose'>;
  emit: (event: BotEvent) => void;
}

/**
 * worker 的 routine_propose：只对成员自己的私聊 / 群聊当前会话开放（委派会话没有 chatId）。
 * chatId 取自会话权威绑定；结果是待批准草稿，群聊时写一条可批准的 system 条目。
 */
export function proposeRoutine(
  deps: Deps,
  conversationId: string,
  binding: { botId: string; chatId: string | null; delegationId?: string },
  params: Record<string, unknown>
): unknown {
  const chat = binding.chatId ? deps.chats.get(binding.chatId) : undefined;
  const bot = deps.bots.get(binding.botId);
  if (
    binding.delegationId ||
    !chat ||
    chat.archivedAt !== undefined ||
    !bot ||
    bot.archivedAt !== undefined ||
    !chat.members.includes(bot.id) ||
    chat.sessions[bot.id]?.conversationId !== conversationId
  )
    return {
      ok: false,
      error: 'Routines can only be proposed from your current private or group chat session.',
    };
  const { title, prompt, schedule, doneBy } = params;
  if (typeof title !== 'string' || !title.trim() || title.length > GROUP_TASK_TITLE_MAX)
    return { ok: false, error: `title is required (at most ${GROUP_TASK_TITLE_MAX} characters).` };
  if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > PROMPT_MAX)
    return { ok: false, error: `prompt is required (at most ${PROMPT_MAX} characters).` };
  const cron = typeof schedule === 'string' ? parseScheduleText(schedule) : undefined;
  if (!cron) return { ok: false, error: SCHEDULE_HINT };
  let executor: BotProfile | undefined;
  if (doneBy !== undefined) {
    if (typeof doneBy !== 'string') return { ok: false, error: 'doneBy must be a member name.' };
    const key = botNameKey(doneBy.trim().replace(/^@/, ''));
    executor = chat.members
      .map((id) => deps.bots.get(id))
      .find((member) => member && botNameKey(member.name) === key);
    if (!executor || executor.archivedAt !== undefined)
      return { ok: false, error: `No active member named "${doneBy}" in this chat.` };
    if (executor.id === bot.id) executor = undefined;
    else {
      const denied = delegationPolicy(bot, executor, 1, 0);
      if (denied) return { ok: false, error: denied };
    }
  }
  const result = deps.routines.propose(bot.id, {
    title,
    prompt,
    schedule: cron,
    chatId: chat.id,
    ...(executor ? { doneBy: executor.id } : {}),
  });
  if (!result.ok) return { ok: false, error: 'Invalid routine.' };
  const { routine } = result;
  const summary = {
    ok: true,
    id: routine.id,
    title: routine.title,
    schedule: `${routine.schedule} (${describeCron(routine.schedule, 'en')})`,
    ...(executor ? { doneBy: executor.name } : {}),
    status: routine.status,
  };
  if (result.unchanged)
    return { ...summary, message: 'An identical routine already exists; nothing changed.' };
  deps.emit({ kind: 'routine' });
  if (chat.kind === 'group') {
    const text = `${bot.name} ${result.created ? '提议了' : '修改了'}例行任务「${routine.title}」（${describeCron(routine.schedule, 'zh')}${executor ? `，由 ${executor.name} 执行` : ''}），等待批准`;
    const entry = deps.chats.appendEntry(chat.id, {
      kind: 'system',
      id: randomUUID(),
      at: Date.now(),
      text,
      routine: { botId: bot.id, id: routine.id },
    });
    if (entry) deps.emit({ kind: 'timeline', chatId: chat.id, seq: entry.seq });
  }
  return {
    ...summary,
    message:
      'Saved as a draft. It will only run after the user approves it in the app; tell the user it is waiting for approval.',
  };
}
