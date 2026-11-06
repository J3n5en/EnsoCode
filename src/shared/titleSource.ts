import { PASTED_TEXT_FILE_NAME, stripPastedTextRefs } from './pastedText';
import { userTextWithoutSkills } from './skillCommands';
import { splitUnattendedPrefix } from './unattendedNote';
import { parseWorkflowPresetMessage } from './workflowPresetMessage';

export const INLINE_CHAT_REF =
  /\[Referenced past chat "(.+?)" — transcript file: (.+?) \(pi session jsonl; read it if relevant\)\]/g;
export const INLINE_UI_REF = /\[Selected UI element "([^"]*)" — path: (.*?); text: (.*?)\]/g;

/** 把引用块折叠成 @标题，供标题/纯文本展示用（引用块原文不得污染标题） */
export function mentionDisplayText(text: string): string {
  return text
    .replace(INLINE_CHAT_REF, (_match, label: string) => `@${label}`)
    .replace(INLINE_UI_REF, (_match, label: string) => `@${label}`);
}

const CONTINUATION_LINE = /^(?:从这里继续|继续|continue(?:\s+here)?)\s*[:：]?\s*$/i;

/** 清洗送给标题总结模型的输入文本：剥离内部引用块与跳转引导词，返回纯净的用户自然语言或被引标题 */
export function cleanTitleSummarySource(text: string): string {
  const prepared = stripPastedTextRefs(splitUnattendedPrefix(text).rest).trim();
  const skills = userTextWithoutSkills(prepared);
  const trimmed = skills.text;
  if (!trimmed) return skills.names[0] ?? '';

  const chatLabels: string[] = [];
  for (const match of trimmed.matchAll(INLINE_CHAT_REF)) {
    if (match[1]?.trim()) chatLabels.push(match[1].trim());
  }

  const stripped = trimmed.replace(INLINE_CHAT_REF, '').replace(INLINE_UI_REF, '');

  const lines = stripped
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  while (lines.length > 1 && CONTINUATION_LINE.test(lines[0])) {
    lines.shift();
  }
  const cleanBody = lines.join('\n').trim();

  if (cleanBody && !CONTINUATION_LINE.test(cleanBody)) {
    return cleanBody;
  }

  if (chatLabels.length > 0) {
    return chatLabels[0];
  }

  if (skills.names[0]) return skills.names[0];
  return cleanBody;
}

/**
 * 从首条消息中提取代表行作为暂存标题（截断到 40 字符）。
 * 跳过像「从这里继续:」这类无实质意义的引导行，优先选用后续自然语言；
 * 引用块折叠成 @标题；空则兜底 '[image]'。
 */
export function extractRepresentativeTitle(text: string): string {
  const visible = splitUnattendedPrefix(text).rest;
  const workflow = parseWorkflowPresetMessage(visible);
  if (workflow) return workflow.name.slice(0, 40);
  const withoutPasted = stripPastedTextRefs(visible);
  const skills = userTextWithoutSkills(withoutPasted);
  if (!skills.text) {
    if (skills.names[0]) return skills.names[0].slice(0, 40);
    return withoutPasted === text ? '[image]' : PASTED_TEXT_FILE_NAME;
  }
  const displayed = mentionDisplayText(skills.text);
  const lines = displayed
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  if (lines.length === 0) return withoutPasted === text ? '[image]' : PASTED_TEXT_FILE_NAME;

  let selected = lines[0];
  if (CONTINUATION_LINE.test(selected) && lines.length > 1) {
    const nonRef = lines.slice(1).find((l) => !l.startsWith('@') && !CONTINUATION_LINE.test(l));
    selected = nonRef ?? lines[1];
  }

  return (selected || '[image]').slice(0, 40);
}
