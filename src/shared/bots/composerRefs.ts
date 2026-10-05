/** Bot 输入框引用：@聊天摘录与 $技能块。Main 拼接，renderer 只拆出来渲染 chip。 */

export const CHAT_REF_MAX_PER_MESSAGE = 3;
export const CHAT_REF_ROUNDS = 3;
export const CHAT_REF_CHAT_CHARS = 4000;
export const CHAT_REF_MESSAGE_CHARS = 1200;

export interface ExcerptMessage {
  speaker: string;
  human: boolean;
  text: string;
}

/** 最近 N 轮：从倒数第 N 条人类消息起；人类消息不足 N 条时整段保留 */
export function recentRounds(
  messages: readonly ExcerptMessage[],
  rounds = CHAT_REF_ROUNDS
): ExcerptMessage[] {
  let seen = 0;
  for (let index = messages.length - 1; index >= 0; index--) {
    if (messages[index].human && ++seen === rounds) return messages.slice(index);
  }
  return [...messages];
}

const attr = (value: string) =>
  value
    .replace(/["<>[\]\r\n]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const clip = (text: string, max: number) =>
  text.length <= max ? text : `${text.slice(0, max - 1)}…`;

const neutralize = (text: string) => text.replace(/<(\/?)chat-reference/gi, '‹$1chat-reference');

const INTRO = 'Recent messages quoted from another chat for reference (latest rounds):';

export function formatChatReference(input: {
  chatId: string;
  title: string;
  kind: 'direct' | 'group';
  messages: readonly ExcerptMessage[];
}): string {
  const lines = input.messages
    .map((message) => {
      const text = clip(neutralize(message.text.trim()), CHAT_REF_MESSAGE_CHARS);
      return text ? `[${attr(message.speaker) || '?'}]: ${text}` : '';
    })
    .filter(Boolean);
  const kept: string[] = [];
  let omitted = 0;
  for (let index = lines.length - 1; index >= 0; index--) {
    const omittedNote = index > 0 ? `(${index} earlier messages omitted)\n` : '';
    const next = [INTRO, omittedNote + [lines[index], ...kept].join('\n')].join('\n');
    if (next.length > CHAT_REF_CHAT_CHARS) {
      omitted = index + 1;
      break;
    }
    kept.unshift(lines[index]);
  }
  const body = [
    INTRO,
    ...(omitted ? [`(${omitted} earlier messages omitted)`] : []),
    ...(kept.length ? kept : ['(no messages yet)']),
  ].join('\n');
  return `<chat-reference id="${attr(input.chatId)}" title="${attr(input.title)}" kind="${input.kind}">\n${body}\n</chat-reference>`;
}

export function withChatReferences(text: string, references: readonly string[]): string {
  return [text.trim(), ...references].filter(Boolean).join('\n\n');
}

const CHAT_REF_BLOCK =
  /\n*<chat-reference id="([^"]*)" title="([^"]*)" kind="(?:direct|group)">\n[\s\S]*?\n<\/chat-reference>/g;

export function splitChatReferences(text: string): {
  body: string;
  refs: { id: string; title: string }[];
} {
  const refs: { id: string; title: string }[] = [];
  const body = text.replace(CHAT_REF_BLOCK, (_match, id: string, title: string) => {
    refs.push({ id, title });
    return '';
  });
  return refs.length ? { body: body.trim(), refs } : { body: text, refs };
}

/** 与 pi 的 /skill:name 展开一致（Code 侧技能调用约定），气泡按同一格式渲染技能 chip */
export function formatSkillBlock(input: { name: string; filePath: string; content: string }) {
  const body = input.content.replace(/^\uFEFF?---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, '').trim();
  const baseDir = input.filePath.replace(/[\\/][^\\/]*$/, '');
  return `<skill name="${input.name}" location="${input.filePath}">\nReferences are relative to ${baseDir}.\n\n${body}\n</skill>`;
}

/** 群聊里被投递的成员没有该技能：替代技能块的一行提示 */
export function skillUnavailableNote(name: string): string {
  return `<skill-unavailable name="${attr(name)}">The user invoked the skill "${attr(name)}", which is not enabled for you. Do not pretend to follow it; answer without it or point to a member who has it.</skill-unavailable>`;
}
