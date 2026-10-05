/** Bot 回合结束的系统通知文案；main 段不走共享 i18n（见 notifications.ts） */
import { BOT_TURN_LIMIT_ERROR } from '../../../shared/usage/botUsage';

export type NoticeLang = 'zh' | 'en';
export interface BotNotice {
  title: string;
  body: string;
}

const BODY_MAX = 100;
const plain = (text: string) => text.replace(/\s+/gu, ' ').trim().slice(0, BODY_MAX);

export function directTurnNotice(
  input: { name: string; ok: boolean; text: string; error?: string; estimated?: true },
  lang: NoticeLang
): BotNotice {
  const zh = lang === 'zh';
  if (!input.ok) {
    const estimated = input.estimated ? (zh ? '（按估算）' : ' (estimated)') : '';
    return {
      title: `${input.name} · ${zh ? '回复失败' : 'Reply failed'}`,
      body:
        input.error === BOT_TURN_LIMIT_ERROR
          ? zh
            ? `本回合用量${estimated}超过单回合上限，已停止`
            : `Stopped: per-turn token limit exceeded${estimated}.`
          : plain(input.error ?? '') || (zh ? '本轮没有完成。' : 'The turn did not finish.'),
    };
  }
  return {
    title: `${input.name} · ${zh ? '回复完成' : 'Replied'}`,
    body: plain(input.text) || (zh ? '已完成，等你查看。' : 'Finished and waiting for you.'),
  };
}

/** 群里一条人类消息引发的整串接力合并为一条 */
export function groupBatchNotice(
  input: {
    chatTitle: string;
    names: string[];
    failedNames: string[];
    lastName?: string;
    lastText?: string;
  },
  lang: NoticeLang
): BotNotice {
  const zh = lang === 'zh';
  const list = (names: string[]) => names.join(zh ? '、' : ', ');
  const title =
    input.names.length > 0
      ? `${input.chatTitle} · ${list(input.names)} ${zh ? '已回复' : 'replied'}`
      : `${input.chatTitle} · ${zh ? '回复失败' : 'Reply failed'}`;
  const lines = [
    input.lastName && input.lastText
      ? `${input.lastName}${zh ? '：' : ': '}${plain(input.lastText)}`
      : '',
    input.failedNames.length > 0
      ? `${list(input.failedNames)} ${zh ? '回复失败' : 'failed to reply'}`
      : '',
  ];
  return { title, body: lines.filter(Boolean).join('\n') };
}
