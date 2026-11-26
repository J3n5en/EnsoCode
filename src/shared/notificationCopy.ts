/**
 * 桌面系统通知与手机 Web Push 共用的文案构造。
 * 两端走各自的发出通道（Electron Notification / web-push），但标题与正文在此统一，
 * 避免手机端只剩「回合已完成」这类笼统文案。main 与 phone 都引用本模块（纯函数，无副作用）。
 */

export type NotificationLocale = 'zh' | 'en';

export interface NotificationCopy {
  title: string;
  body: string;
  /** true 表示这条通知是待处理项（审批/提问），手机端据它计角标，不再靠标题文字匹配 */
  pending: boolean;
}

/** 通知正文统一截断长度：系统通知与 Web Push 载荷都不宜过长 */
export const NOTIFICATION_BODY_MAX = 100;

interface CopyText {
  ask: string;
  approval: string;
  turnDone: string;
  turnDoneBody: string;
  failed: string;
}

const TEXTS: Record<NotificationLocale, CopyText> = {
  zh: {
    ask: '等你回答',
    approval: '需要审批',
    turnDone: '回复完成',
    turnDoneBody: 'agent 已完成,等你查看。',
    failed: '会话失败',
  },
  en: {
    ask: 'Question for you',
    approval: 'Approval required',
    turnDone: 'Turn completed',
    turnDoneBody: 'The agent finished and is waiting for you.',
    failed: 'Session failed',
  },
};

export function notificationTexts(locale: NotificationLocale): CopyText {
  return TEXTS[locale];
}

/** 事件中参与文案的字段（桌面与手机传入的都是 RendererAgentEvent 的子集） */
export interface NotificationCopyEvent {
  type: string;
  status?: string;
  ask?: { question?: string };
  request?: { tool?: string; summary?: string };
  error?: string;
  digest?: { assistantText?: string };
}

function clip(text: string): string {
  const trimmed = text.trim();
  return trimmed.length > NOTIFICATION_BODY_MAX ? trimmed.slice(0, NOTIFICATION_BODY_MAX) : trimmed;
}

/**
 * 事件 → 统一通知文案。返回 null 表示该事件类型不出通知。
 * 标题恒为「会话名 · 类型」；无会话名时退化为类型本身。
 * turnDoneSummary 开启时，回合完成的正文优先用本轮 assistant 摘要（手机端），
 * 摘要为空仍回退固定文案。
 */
export function buildNotificationCopy(
  event: NotificationCopyEvent,
  sessionTitle: string | undefined,
  locale: NotificationLocale,
  opts?: { turnDoneSummary?: boolean }
): NotificationCopy | null {
  const t = TEXTS[locale];
  const name = (sessionTitle ?? '').trim();
  const titled = (kind: string) => (name ? `${name} · ${kind}` : kind);

  switch (event.type) {
    case 'ask-request': {
      const question = event.ask?.question ?? '';
      return { title: titled(t.ask), body: clip(question), pending: true };
    }
    case 'approval-request': {
      const tool = event.request?.tool ?? '';
      const summary = event.request?.summary ?? '';
      const body = tool ? `${tool} · ${summary}` : summary;
      return { title: titled(t.approval), body: clip(body), pending: true };
    }
    case 'turn-completed': {
      const summary = opts?.turnDoneSummary ? (event.digest?.assistantText ?? '').trim() : '';
      return {
        title: titled(t.turnDone),
        body: summary ? clip(summary) : t.turnDoneBody,
        pending: false,
      };
    }
    case 'turn-failed': {
      return { title: titled(t.failed), body: clip(event.error ?? ''), pending: false };
    }
    case 'status': {
      // 桌面端失败走 status:failed（worker 生命周期态），与 turn-failed 同文案
      if (event.status !== 'failed' || !event.error) return null;
      return { title: titled(t.failed), body: clip(event.error), pending: false };
    }
    default:
      return null;
  }
}
