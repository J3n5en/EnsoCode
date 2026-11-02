/** 开关翻转时前置在用户消息上的一次性提示；展示层剥掉，不把 XML 露在气泡里 */
const UNATTENDED_PREFIX = /^<unattended>\n([\s\S]*?)\n<\/unattended>(?:\n\n|$)/;

export type UnattendedNoteKind = 'on' | 'off';

export function splitUnattendedPrefix(text: string): { note?: UnattendedNoteKind; rest: string } {
  const match = UNATTENDED_PREFIX.exec(text);
  if (!match) return { rest: text };
  return {
    note: /unattended mode is off/i.test(match[1]) ? 'off' : 'on',
    rest: text.slice(match[0].length),
  };
}
