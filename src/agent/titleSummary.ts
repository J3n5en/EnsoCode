/** 会话标题总结：一次性补全的输入与输出处理（纯函数，供 supervisor 调用）。 */

/** 送给模型的用户消息上限：标题只需要开头，长指令全文只会烧 token */
const MAX_INPUT_CHARS = 2000;

/** 标题上限，与 renameConversation 的 slice(0, 80) 对齐 */
const MAX_TITLE_CHARS = 80;

export const TITLE_SYSTEM_PROMPT = [
  'You generate a short title for a coding conversation based on the user message.',
  'Rules:',
  '- Reply with the title text only: no quotes, no trailing punctuation, no explanations.',
  '- Keep it under 20 characters for CJK languages, or about 6 words for English.',
  '- Write the title in the same language as the user message.',
].join('\n');

const INLINE_CHAT_REF =
  /\[Referenced past chat "(.+?)" — transcript file: (.+?) \(pi session jsonl; read it if relevant\)\]/g;
const INLINE_UI_REF = /\[Selected UI element "([^"]*)" — path: (.*?); text: (.*?)\]/g;
const CONTINUATION_LINE = /^(?:从这里继续|继续|continue(?:\s+here)?)\s*[:：]?\s*$/i;

export function buildTitleUserText(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return '';

  const chatLabels: string[] = [];
  for (const match of trimmed.matchAll(INLINE_CHAT_REF)) {
    if (match[1]?.trim()) chatLabels.push(match[1].trim());
  }

  const stripped = trimmed
    .replace(INLINE_CHAT_REF, '')
    .replace(INLINE_UI_REF, '');

  const lines = stripped
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  while (lines.length > 1 && CONTINUATION_LINE.test(lines[0])) {
    lines.shift();
  }
  const cleanBody = lines.join('\n').trim();

  if (cleanBody && !CONTINUATION_LINE.test(cleanBody)) {
    return cleanBody.slice(0, MAX_INPUT_CHARS);
  }

  if (chatLabels.length > 0) {
    return chatLabels[0].slice(0, MAX_INPUT_CHARS);
  }

  return cleanBody.slice(0, MAX_INPUT_CHARS);
}

/** 模型习惯性包裹的引号/书名号对 */
const QUOTE_PAIRS: [string, string][] = [
  ['"', '"'],
  ["'", "'"],
  ['“', '”'],
  ['‘', '’'],
  ['「', '」'],
  ['『', '』'],
  ['《', '》'],
];

/**
 * 从一次性补全的回复中提取可用标题。
 * 脏输入（缺字段、错类型、错误回复）一律返回空串——标题不值得让 worker 崩。
 */
export function extractTitle(message: unknown): string {
  if (!message || typeof message !== 'object') return '';
  const { content, stopReason } = message as { content?: unknown; stopReason?: unknown };
  if (stopReason === 'error' || stopReason === 'aborted') return '';
  if (!Array.isArray(content)) return '';
  const text = content
    .map((part) =>
      part && typeof part === 'object' && (part as { type?: unknown }).type === 'text'
        ? String((part as { text?: unknown }).text ?? '')
        : ''
    )
    .join('');
  // 模型可能附加解释：只取首个非空行
  const line = text.split('\n').find((candidate) => candidate.trim().length > 0) ?? '';
  let title = line.trim();
  for (const [open, close] of QUOTE_PAIRS) {
    if (title.startsWith(open) && title.endsWith(close) && title.length > open.length) {
      title = title.slice(open.length, title.length - close.length).trim();
    }
  }
  title = title.replace(/[。．.！!？?：:，,…]+$/u, '').trim();
  return title.slice(0, MAX_TITLE_CHARS);
}
