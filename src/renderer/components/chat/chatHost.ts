import { createContext, useContext } from 'react';

/**
 * 时间线的宿主上下文：告诉 TimelineRow 里少数「越过 props 直接读 store」的组件
 * 当前展示的是谁的会话、能做什么。
 * - 本机 ChatView 不提供（null）：保持现行为，直接读 useSessionsStore。
 * - 远程节点视图提供 { sessionId, canRewind:false, canRetry:false }：
 *   回退/重试协议不支持，直接不渲染入口；计时 key 用远程会话 id 而非本机 active 会话。
 */
export interface ChatHost {
  sessionId: string | null;
  canRewind: boolean;
  canRetry: boolean;
}

export const ChatHostContext = createContext<ChatHost | null>(null);

export function useChatHost(): ChatHost | null {
  return useContext(ChatHostContext);
}
