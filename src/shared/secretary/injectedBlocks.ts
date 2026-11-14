/** 聊天里系统注入的整块标签。不是通用 XML 解析器。 */
const TAG =
  'agent-notification|goal-continuation|coworker-hired|coworker-dismissed|background-task-update|session-updates|secretary-schedule';
const BLOCK = new RegExp(`<(${TAG})>\\n?([\\s\\S]*?)\\n?</\\1>`, 'g');
const INSTRUCTIONS = /\n(?=Work toward this goal autonomously\.|Continue working toward it\.)/;

export type InjectedSegment =
  | { kind: 'text'; text: string }
  | { kind: 'goal'; goal: string; instructions: string }
  | { kind: 'updates'; raw: string }
  | { kind: 'notice'; tag: string; body: string };

export function goalHeadline(goal: string): string {
  const line = goal
    .split('\n')
    .map((part) => part.trim())
    .find(Boolean);
  const sentence = (line ?? '').split(/(?<=[。！？.!?])\s*/)[0]?.trim() ?? '';
  if (sentence.length <= 72) return sentence;
  return `${sentence.slice(0, 72)}…`;
}

function parseGoal(body: string): { goal: string; instructions: string } {
  const trimmed = body.trim();
  const head = /^(?:Session goal(?: resumed)?:[ \t]*)([\s\S]*)$/.exec(trimmed);
  const rest = (head ? head[1] : trimmed).trim();
  const split = rest.search(INSTRUCTIONS);
  if (split < 0) return { goal: rest, instructions: '' };
  return { goal: rest.slice(0, split).trim(), instructions: rest.slice(split).trim() };
}

/** 没有这些块时返回 null，调用方按普通正文渲染。 */
export function splitInjectedBlocks(text: string): InjectedSegment[] | null {
  const segments: InjectedSegment[] = [];
  const pattern = new RegExp(BLOCK.source, 'g');
  let cursor = 0;
  let found = false;
  for (const match of text.matchAll(pattern)) {
    found = true;
    const index = match.index ?? 0;
    if (index > cursor) segments.push({ kind: 'text', text: text.slice(cursor, index) });
    const tag = match[1] ?? '';
    const body = match[2] ?? '';
    if (tag === 'goal-continuation') segments.push({ kind: 'goal', ...parseGoal(body) });
    else if (tag === 'session-updates' || tag === 'secretary-schedule')
      segments.push({ kind: 'updates', raw: match[0] });
    else segments.push({ kind: 'notice', tag, body });
    cursor = index + match[0].length;
  }
  if (!found) return null;
  if (cursor < text.length) segments.push({ kind: 'text', text: text.slice(cursor) });
  return segments;
}
