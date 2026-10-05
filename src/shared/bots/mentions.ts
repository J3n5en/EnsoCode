import { BOT_MENTION_ALL, type BotId, botNameKey } from '../types/bot';

export interface MentionMember {
  id: BotId;
  name: string;
}

export interface ParsedMentions {
  ids: BotId[];
  all: boolean;
}

/** @ 前紧挨着这些字符时视为邮箱等，不算提及 */
const EMAIL_LOCAL_RE = /[A-Za-z0-9._%+-]/;
const ASCII_WORD_RE = /[A-Za-z0-9_-]/;
const CODE_RE = /```[\s\S]*?(?:```|$)|`[^`\n]*`/g;

function validMembers(members: unknown): MentionMember[] {
  if (!Array.isArray(members)) return [];
  return members.filter(
    (m): m is MentionMember =>
      Boolean(m) &&
      typeof m === 'object' &&
      typeof m.id === 'string' &&
      typeof m.name === 'string' &&
      m.name.length > 0
  );
}

function scanMentions(text: string, list: MentionMember[]): ParsedMentions {
  if (typeof text !== 'string') return { ids: [], all: false };
  const source = text.normalize('NFC').replace(CODE_RE, (code) => ' '.repeat(code.length));
  const candidates = [
    ...list.map((m) => ({ key: botNameKey(m.name), id: m.id as BotId | null })),
    ...BOT_MENTION_ALL.map((word) => ({ key: botNameKey(word), id: null })),
  ].sort((a, b) => b.key.length - a.key.length);
  const ids: BotId[] = [];
  let all = false;
  for (let at = source.indexOf('@'); at !== -1; at = source.indexOf('@', at + 1)) {
    if (at > 0 && EMAIL_LOCAL_RE.test(source[at - 1])) continue;
    const hit = candidates.find(({ key }) => {
      const end = at + 1 + key.length;
      if (source.slice(at + 1, end).toLowerCase() !== key) return false;
      const after = source[end];
      return !(after && ASCII_WORD_RE.test(key.at(-1) ?? '') && ASCII_WORD_RE.test(after));
    });
    if (!hit) continue;
    if (hit.id === null) all = true;
    else if (!ids.includes(hit.id)) ids.push(hit.id);
  }
  return { ids, all };
}

/** 识别 `@名字`：已知名字最长匹配，ASCII 结尾的名字要求后面不再接 ASCII 单词字符 */
export function parseMentions(text: string, members: readonly MentionMember[]): ParsedMentions {
  const list = validMembers(members);
  const { ids, all } = scanMentions(text, list);
  if (all) return { ids: [...new Set(list.map((m) => m.id))], all };
  return { ids, all };
}

/** 只取点名的成员（@所有人 不展开） */
export function namedMentions(text: string, members: readonly MentionMember[]): BotId[] {
  return scanMentions(text, validMembers(members)).ids;
}

/** 输入框 @ 补全：前缀（可带 @）不分大小写过滤，保持成员顺序 */
export function mentionCandidates<T extends MentionMember>(
  prefix: string,
  members: readonly T[]
): T[] {
  const key = botNameKey(typeof prefix === 'string' ? prefix.replace(/^@/, '') : '');
  return validMembers(members).filter((m) => botNameKey(m.name).startsWith(key)) as T[];
}
