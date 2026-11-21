import { type PlanNoteKind, splitPlanPrefix } from './planMode';
import { splitUnattendedPrefix, type UnattendedNoteKind } from './unattendedNote';

/** 回合收尾时没表态的后台任务清单：搭在下一条进模型的消息前，展示层剥掉 */
export const TASK_WRAP_UP_TAG = 'background-tasks-wrap-up';
const TASK_WRAP_UP_PREFIX = new RegExp(
  `^<${TASK_WRAP_UP_TAG}>\\n[\\s\\S]*?\\n</${TASK_WRAP_UP_TAG}>(?:\\n\\n|$)`
);

/** Plan / 无人值守 / 收尾清单的一次性提示可按任意顺序叠在正文前 */
export function splitTurnNotes(text: string): {
  plan?: PlanNoteKind;
  unattended?: UnattendedNoteKind;
  rest: string;
} {
  let rest = text;
  let plan: PlanNoteKind | undefined;
  let unattended: UnattendedNoteKind | undefined;
  for (;;) {
    const p = plan ? { rest } : splitPlanPrefix(rest);
    if (p.note) {
      plan = p.note;
      rest = p.rest;
      continue;
    }
    const wrapUp = TASK_WRAP_UP_PREFIX.exec(rest);
    if (wrapUp) {
      rest = rest.slice(wrapUp[0].length);
      continue;
    }
    const u = unattended ? { rest } : splitUnattendedPrefix(rest);
    if (!u.note) break;
    unattended = u.note;
    rest = u.rest;
  }
  return { ...(plan ? { plan } : {}), ...(unattended ? { unattended } : {}), rest };
}

/** 提示插在开头连续的 /skill: 之后：前置会让 pi 不再识别 /skill: */
export function prependTurnNote(note: string, text: string): string {
  const match = /^(?:\/skill:\S+(?:\s+|$))+/.exec(text);
  if (!match) return `${note}\n\n${text}`;
  const rest = text.slice(match[0].length);
  return `${match[0].trimEnd()} ${note}${rest ? `\n\n${rest}` : ''}`;
}
