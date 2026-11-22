import { type PlanNoteKind, splitPlanPrefix } from './planMode';
import { splitUnattendedPrefix, type UnattendedNoteKind } from './unattendedNote';

/** 回合收尾时没表态的后台任务清单：搭在下一条进模型的消息前，展示层剥掉 */
export const TASK_WRAP_UP_TAG = 'background-tasks-wrap-up';
const TASK_WRAP_UP_PREFIX = new RegExp(
  `^<${TASK_WRAP_UP_TAG}>\\n[\\s\\S]*?\\n</${TASK_WRAP_UP_TAG}>(?:\\n\\n|$)`
);
const TASK_LINE = /^- (\S+?): (.*?)(?: \(running ([^()]+)\))?$/;

/** 清单里的一条任务；命令是发给模型时已压成单行、截到 160 字的样子 */
export interface TaskWrapUpItem {
  taskId: string;
  command: string;
  ran?: string;
}

function parseTaskWrapUp(block: string): TaskWrapUpItem[] {
  const items: TaskWrapUpItem[] = [];
  for (const line of block.split('\n')) {
    const match = TASK_LINE.exec(line);
    if (!match?.[1]) continue;
    items.push({
      taskId: match[1],
      command: match[2] ?? '',
      ...(match[3] ? { ran: match[3] } : {}),
    });
  }
  return items;
}

/** 正文开头的收尾清单（不含前面的 Plan / 无人值守提示）；没有返回 null */
export function splitTaskWrapUpPrefix(
  text: string
): { items: TaskWrapUpItem[]; rest: string } | null {
  const match = TASK_WRAP_UP_PREFIX.exec(text);
  if (!match) return null;
  return { items: parseTaskWrapUp(match[0]), rest: text.slice(match[0].length) };
}

function peelTurnNotes(text: string): {
  plan?: PlanNoteKind;
  unattended?: UnattendedNoteKind;
  wrapUp?: { items: TaskWrapUpItem[]; start: number; end: number };
  rest: string;
} {
  let rest = text;
  let plan: PlanNoteKind | undefined;
  let unattended: UnattendedNoteKind | undefined;
  let wrapUp: { items: TaskWrapUpItem[]; start: number; end: number } | undefined;
  for (;;) {
    const p = plan ? { rest } : splitPlanPrefix(rest);
    if (p.note) {
      plan = p.note;
      rest = p.rest;
      continue;
    }
    const found = wrapUp ? null : splitTaskWrapUpPrefix(rest);
    if (found) {
      const start = text.length - rest.length;
      wrapUp = { items: found.items, start, end: start + rest.length - found.rest.length };
      rest = found.rest;
      continue;
    }
    const u = unattended ? { rest } : splitUnattendedPrefix(rest);
    if (!u.note) break;
    unattended = u.note;
    rest = u.rest;
  }
  return { ...(plan ? { plan } : {}), ...(unattended ? { unattended } : {}), wrapUp, rest };
}

/** Plan / 无人值守 / 收尾清单的一次性提示可按任意顺序叠在正文前 */
export function splitTurnNotes(text: string): {
  plan?: PlanNoteKind;
  unattended?: UnattendedNoteKind;
  rest: string;
} {
  const { plan, unattended, rest } = peelTurnNotes(text);
  return { ...(plan ? { plan } : {}), ...(unattended ? { unattended } : {}), rest };
}

/** 叠在正文前的提示里有没有收尾清单 */
export function leadingTaskWrapUp(text: string): { items: TaskWrapUpItem[] } | undefined {
  const found = peelTurnNotes(text).wrapUp;
  return found ? { items: found.items } : undefined;
}

/** 去掉叠在正文前的收尾清单，其余提示与正文原样保留（复制用户消息时用） */
export function withoutTaskWrapUp(text: string): string {
  const found = peelTurnNotes(text).wrapUp;
  return found ? text.slice(0, found.start) + text.slice(found.end) : text;
}

/** 提示插在开头连续的 /skill: 之后：前置会让 pi 不再识别 /skill: */
export function prependTurnNote(note: string, text: string): string {
  const match = /^(?:\/skill:\S+(?:\s+|$))+/.exec(text);
  if (!match) return `${note}\n\n${text}`;
  const rest = text.slice(match[0].length);
  return `${match[0].trimEnd()} ${note}${rest ? `\n\n${rest}` : ''}`;
}
