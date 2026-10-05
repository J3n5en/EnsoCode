import { stripInterjection } from './interject';

/** 成员 / 群核心笔记上限（字符），写入时截断 */
export const BOT_NOTES_MAX_CHARS = 3000;

const NOTES_UPDATE_RE = /^\s*<notes-updated>[\s\S]*?<\/notes-updated>\s*/;

/** Main 在投递前追加的笔记更新块与插话补充说明：展示与协议识别时跳过 */
export function stripBotNotesUpdate(text: string): string {
  return stripInterjection(text.replace(NOTES_UPDATE_RE, ''));
}
