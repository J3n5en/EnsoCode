import { createContext, type ReactNode, useContext } from 'react';

/**
 * 时间线的宿主上下文：告诉 TimelineRow 里少数「越过 props 直接读 store」的组件
 * 当前展示的是谁的会话、能做什么。
 * - 本机 ChatView 不提供（null）：保持现行为，直接读 useSessionsStore。
 * - 远程节点视图提供 { sessionId, canRewind:false, canRetry:false }：
 *   回退/重试协议不支持，直接不渲染入口；计时 key 用远程会话 id 而非本机 active 会话。
 */
/** image：成员图片头像 URL（缺省用 color + 首字） */
export interface ChatSpeaker {
  name: string;
  color: string;
  image?: string;
}

export interface ChatHost {
  sessionId: string | null;
  canRewind: boolean;
  canRetry: boolean;
  /** 缺省跟随 canRewind；手机 PWA 开回退但不开分叉 */
  canFork?: boolean;
  /** 回复头的发言人；缺省显示 Enso（Bot 模式显示成员名与头像） */
  speaker?: ChatSpeaker;
  botSession?: boolean;
  /** 一轮最终回复正文下方的附加内容（Bot 私聊的产物卡片）；参数为该消息绝对下标 */
  turnFooter?: (messageIndex: number) => ReactNode;
  /**
   * Bot 私聊回退 / 重试：会话投影在 bots store（sessionId 为键），
   * 入口经 Bot IPC 走 Main 而不是 sessions store。
   */
  botControls?: {
    /** 投影订阅（useSyncExternalStore），避免时间线直接依赖 bots store */
    subscribe: (listener: () => void) => () => void;
    projection: () =>
      | {
          status: string;
          messages: readonly { role: string; entryId?: string; optimistic?: boolean }[];
          historyBaseIndex?: number;
        }
      | undefined;
    rewind: (entryId: string, restoreFiles: boolean) => void;
    retry: () => void;
  };
}

export const ChatHostContext = createContext<ChatHost | null>(null);

export function useChatHost(): ChatHost | null {
  return useContext(ChatHostContext);
}
