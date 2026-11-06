import { type PlanNoteKind, splitPlanPrefix } from './planMode';
import { splitUnattendedPrefix, type UnattendedNoteKind } from './unattendedNote';

/** Plan / 无人值守的一次性提示可按任意顺序叠在正文前 */
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
