import type { ChatHost } from '@/components/chat/chatHost';

/** 成员会话标 botSession：时间线按桌面一样把 Main 注入的群消息 / 委派 / 引用拆成卡片 */
export function phoneChatHost(input: {
  sessionId: string | null;
  bot?: object;
  deviceReadOnly?: boolean;
}): ChatHost {
  return {
    sessionId: input.sessionId,
    canRewind: !input.bot && !input.deviceReadOnly,
    canRetry: !input.bot && !input.deviceReadOnly,
    canFork: false,
    ...(input.bot ? { botSession: true } : {}),
  };
}
