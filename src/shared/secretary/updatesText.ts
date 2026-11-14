import type { SecretaryResultKind } from '../types/secretary';
import { RESULT_KINDS } from './parse';

export type SecretaryUpdateLine =
  | { kind: SecretaryResultKind; text: string; conversationId?: string; detail?: string }
  | { kind: 'proposal' | 'schedule'; text: string; detail?: string };

const BLOCK = /^<(session-updates|secretary-schedule)>\n([\s\S]*?)\n<\/\1>(?:\n|$)/;
const HEAD = /^- \[([a-z-]+)(?: session:([^\]\s]+))?\] ([^\n]*)(?:\n|$)/;
const DETAIL = /^<untrusted-content source="[^"]*">/;
const END_TAG = '</untrusted-content>';

function isResultKind(kind: string): kind is SecretaryResultKind {
  return (RESULT_KINDS as readonly string[]).includes(kind);
}

function lineOf(
  tag: string,
  kind: string,
  conversationId: string | undefined,
  text: string
): SecretaryUpdateLine | null {
  if (tag === 'secretary-schedule')
    return kind === 'schedule' && !conversationId ? { kind, text } : null;
  if (kind === 'proposal') return conversationId ? null : { kind, text };
  if (!isResultKind(kind)) return null;
  return conversationId ? { kind, text, conversationId } : { kind, text };
}

function parseBody(tag: string, body: string): SecretaryUpdateLine[] | null {
  const lines: SecretaryUpdateLine[] = [];
  let rest = body;
  while (rest) {
    const head = HEAD.exec(rest);
    const line = head && lineOf(tag, head[1], head[2], head[3]);
    if (!head || !line) return null;
    rest = rest.slice(head[0].length);
    const open = DETAIL.exec(rest);
    if (open) {
      // 正文里的结束标签在注入时已转义，第一个未转义的才是包裹的结尾
      const end = rest.indexOf(END_TAG);
      if (end < 0) return null;
      line.detail = rest
        .slice(open[0].length, end)
        .split('<\\/untrusted-content')
        .join('</untrusted-content');
      rest = rest.slice(end + END_TAG.length);
      if (rest.startsWith('\n')) rest = rest.slice(1);
      else if (rest) return null;
    }
    lines.push(line);
  }
  return lines.length > 0 ? lines : null;
}

/** 秘书回传是整条注入的用户消息；混了别的文字就不是回传，按普通消息显示 */
export function parseSecretaryUpdates(text: string): SecretaryUpdateLine[] | null {
  const lines: SecretaryUpdateLine[] = [];
  let rest = text.trim();
  while (rest) {
    const block = BLOCK.exec(rest);
    const parsed = block && parseBody(block[1], block[2]);
    if (!block || !parsed) return null;
    lines.push(...parsed);
    rest = rest.slice(block[0].length);
  }
  return lines.length > 0 ? lines : null;
}
