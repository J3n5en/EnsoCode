import { unescapeUntrusted } from './transcript';

/** 聊天里系统注入的整块标签。不是通用 XML 解析器。 */
const TAG =
  'agent-notification|goal-continuation|coworker-hired|coworker-dismissed|background-task-update|session-updates|secretary-schedule|secretary-message|secretary-trigger';
const BLOCK = new RegExp(`<(${TAG})>\\n?([\\s\\S]*?)\\n?</\\1>`, 'g');
const INSTRUCTIONS = /\n(?=Work toward this goal autonomously\.|Continue working toward it\.)/;

export type InjectedSegment =
  | { kind: 'text'; text: string }
  | { kind: 'goal'; goal: string; instructions: string }
  | { kind: 'updates'; raw: string }
  | { kind: 'schedule'; raw: string }
  | { kind: 'trigger'; raw: string }
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
    else if (tag === 'secretary-schedule') segments.push({ kind: 'schedule', raw: match[0] });
    else if (tag === 'secretary-trigger') segments.push({ kind: 'trigger', raw: match[0] });
    else if (tag === 'session-updates') segments.push({ kind: 'updates', raw: match[0] });
    else segments.push({ kind: 'notice', tag, body });
    cursor = index + match[0].length;
  }
  if (!found) return null;
  if (cursor < text.length) segments.push({ kind: 'text', text: text.slice(cursor) });
  return segments;
}

const WRAPPER_LINE =
  /^<\/?(?:agent-notification|goal-continuation|coworker-hired|coworker-dismissed|background-task-update|session-updates|secretary-schedule|secretary-message|secretary-trigger)>$/;

export interface FoldedInjected {
  summary: string;
  body: string;
}

/** 去掉系统标签行。调用方不该把 `<secretary-schedule>` 这种外壳画出来。 */
export function stripInjectedWrapperLines(text: string): string {
  return text
    .split('\n')
    .filter((line) => !WRAPPER_LINE.test(line.trim()))
    .join('\n')
    .trim();
}

function clipLine(line: string): string {
  if (line.length <= 72) return line;
  return `${line.slice(0, 72)}…`;
}

/**
 * 冒号前不超过 8 个字当作定时名称，标题用后面的提示词；
 * 更长的前半本身就是那句人话，不再切开。
 */
function scheduleText(text: string): FoldedInjected {
  const trimmed = text.trim();
  const breakAt = trimmed.indexOf('\n');
  const first = (breakAt < 0 ? trimmed : trimmed.slice(0, breakAt)).trim();
  const colon = first.indexOf('：');
  if (colon > 0 && colon <= 8) {
    const rest = first.slice(colon + 1).trim();
    if (rest) {
      const tail = breakAt < 0 ? '' : trimmed.slice(breakAt + 1);
      return { summary: clipLine(rest), body: tail ? `${rest}\n${tail.trim()}` : rest };
    }
  }
  return { summary: clipLine(first), body: trimmed };
}

/** 一条定时块收成若干张卡片：默认一行人话，正文是完整提示词。 */
export function scheduleFolds(raw: string): FoldedInjected[] {
  const inner = stripInjectedWrapperLines(raw);
  if (!inner) return [];
  return inner
    .split(/\n(?=- \[schedule\])/)
    .map((chunk) => scheduleText(chunk.replace(/^- \[schedule\][ \t]?/, '')))
    .filter((fold) => fold.body.length > 0);
}

/** 一条触发器块收成若干张卡片：标题取触发器名与来源，正文展开原始事件内容（去掉不可信外壳）。 */
export function triggerFolds(raw: string): FoldedInjected[] {
  const inner = stripInjectedWrapperLines(raw);
  if (!inner) return [];
  const chunks = inner.split(/\n(?=- \[trigger )/);
  const folds: FoldedInjected[] = [];
  for (const chunk of chunks) {
    const head = /^- \[trigger [^\]]*name="([^"]*)"[^\]]*\](?: \(([^)\n]*)\))?/.exec(chunk);
    const name = head?.[1]?.trim() ?? '';
    const source = head?.[2]?.trim() ?? '';
    const rest = head ? chunk.slice(head[0].length).trim() : chunk.trim();
    const cleaned = rest
      .replace(
        /<untrusted-content source="[^"\n]*">([\s\S]*?)<\/untrusted-content>/g,
        (_, innerText: string) => unescapeUntrusted(innerText)
      )
      .trim();
    const summaryBase = [name, source].filter(Boolean).join(' · ');
    const firstBodyLine = cleaned
      .split('\n')
      .map((line) => line.trim())
      .find(Boolean);
    const summary = clipLine(summaryBase || firstBodyLine || '');
    const body = cleaned || summary;
    if (body) folds.push({ summary, body });
  }
  return folds;
}

/** 解析不了的回传：去掉标签和列表标记，避免虚线框里只剩标签名。 */
export function updatesFold(raw: string): FoldedInjected {
  const body = stripInjectedWrapperLines(raw)
    .replace(/^- \[[a-z-]+(?: session:[^\]]+)?\][ \t]?/gm, '')
    .trim();
  const first = body
    .split('\n')
    .map((line) => line.trim())
    .find(Boolean);
  return { summary: clipLine(first ?? ''), body };
}
