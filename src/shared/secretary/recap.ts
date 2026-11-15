import type { ContactLang } from './contact';
import { parseInboundMessage } from './inbound';
import { isPureSessionUpdate } from './silence';

/** /last 默认回看一轮，最多十轮：再多手机上就是刷屏 */
export const RECAP_DEFAULT_ROUNDS = 1;
export const RECAP_MAX_ROUNDS = 10;

export interface RecapMessage {
  role: 'user' | 'assistant';
  text: string;
}

/** 一轮 = 用户说的话 + 秘书的回复 */
export interface RecapTurn {
  user: string;
  assistant: string;
}

/** /last 的参数：空是 1 轮；只认 1..10 的整数，其他一律当写错 */
export function parseRecapRounds(arg: string): number | null {
  const value = arg.trim();
  if (!value) return RECAP_DEFAULT_ROUNDS;
  if (!/^\d{1,2}$/u.test(value)) return null;
  const rounds = Number(value);
  return rounds >= 1 && rounds <= RECAP_MAX_ROUNDS ? rounds : null;
}

/** 手机发来的话在会话里包着头与不可信标签，回看时还原成用户打的字 */
function displayText(text: string): string {
  return (parseInboundMessage(text)?.body ?? text).trim();
}

/**
 * 按轮切：系统回传（session-updates / 定时任务）不算对话，整轮跳过；
 * 没有回复的最后一轮（还在跑）也不算完整的一轮。
 */
export function buildRecapTurns(messages: readonly RecapMessage[], rounds: number): RecapTurn[] {
  const turns: RecapTurn[] = [];
  let user: string | null = null;
  let replies: string[] = [];
  const flush = (): void => {
    if (user !== null && replies.length > 0) turns.push({ user, assistant: replies.join('\n\n') });
    user = null;
    replies = [];
  };
  for (const message of messages) {
    if (message.role === 'user') {
      flush();
      if (isPureSessionUpdate(message.text)) continue;
      const text = displayText(message.text);
      user = text ? text : null;
      continue;
    }
    const text = message.text.trim();
    if (user !== null && text) replies.push(text);
  }
  flush();
  return turns.slice(-Math.max(1, rounds));
}

/** 正文里只有「你：」「昵称：」两种行首，按 markdown 交给现有出站路径 */
export function formatRecapMessage(
  lang: ContactLang,
  input: { turns: readonly RecapTurn[]; name: string }
): string {
  const you = lang === 'zh' ? '你' : 'You';
  const name = input.name.trim() || (lang === 'zh' ? '秘书' : 'Secretary');
  const colon = lang === 'zh' ? '：' : ': ';
  return input.turns
    .map((turn) => `${you}${colon}${turn.user}\n${name}${colon}${turn.assistant}`)
    .join('\n\n');
}

export function recapEmptyText(lang: ContactLang): string {
  return lang === 'zh' ? '还没有可以回看的对话。' : 'No conversation to show yet.';
}

export function recapUsageText(lang: ContactLang): string {
  return lang === 'zh'
    ? `轮数看不懂。用 /last 或 /last 3，最多 ${RECAP_MAX_ROUNDS} 轮。`
    : `Unrecognized count. Use /last or /last 3, up to ${RECAP_MAX_ROUNDS} rounds.`;
}
