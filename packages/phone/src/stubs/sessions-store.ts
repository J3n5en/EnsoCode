import type { ProjectedMessage } from '@shared/types/agent';

/**
 * `@/stores/sessions` 的 PWA 桩：手机端会话状态在 client.ts，不用 zustand。
 * 形状对齐桌面被复用组件读取的字段（activeId / conversations / rewind），
 * 使 RewindButton、RunningElapsed 无需改动即可编译并自动降级：
 * started 恒为 false → RewindButton 直接不渲染。
 * 经 vite alias 注入，桌面源码零改动。
 */

export interface SessionGoal {
  text: string;
  status: 'active' | 'paused';
}

export interface QueuedMessage {
  id: string;
  text: string;
  images?: { data: string; mimeType: string }[];
}

export interface Conversation {
  id: string;
  status: string;
  started: boolean;
  spawning: boolean;
  messages: ProjectedMessage[];
  activeTabId?: string;
  queuedMessages?: QueuedMessage[];
}

/** 队列操作：真正的队列在桌面 renderer store，手机只发命令，由 App 注入 */
export interface QueueActions {
  removeQueuedMessage(conversationId: string, messageId: string): void;
  updateQueuedMessage(conversationId: string, messageId: string, text: string): void;
  sendQueuedNow(conversationId: string, messageId: string): void;
  interruptAndSendQueued(conversationId: string, messageId: string): Promise<void>;
}

type SessionsSlice = {
  activeId: string | null;
  conversations: Record<string, Conversation>;
  rewind(sessionId: string, userIndexFromEnd: number, restoreFiles?: boolean): void;
  retry(sessionId: string): void;
} & QueueActions;

const state: SessionsSlice = {
  activeId: null,
  conversations: {},
  // 手机端不支持回退（RewindButton 因 started=false 已不渲染，这里只为类型完整）
  rewind: () => {},
  retry: () => {},
  removeQueuedMessage: () => {},
  updateQueuedMessage: () => {},
  sendQueuedNow: () => {},
  interruptAndSendQueued: async () => {},
};

/** App 启动时注入：把桌面 MessageQueue 组件的 store 调用转成 pair 命令 */
export function setQueueActions(actions: QueueActions): void {
  Object.assign(state, actions);
}

/** 由 ChatScreen 在渲染前同步当前会话，供复用组件内部读取 */
export function setDisplayedConversation(next: Conversation | null): void {
  if (!next) {
    state.activeId = null;
    state.conversations = {};
    return;
  }
  state.activeId = next.id;
  state.conversations = { [next.id]: next };
}

export function displayedConversation(s: SessionsSlice): Conversation | null {
  const active = s.activeId ? s.conversations[s.activeId] : null;
  if (!active) return null;
  return active.activeTabId ? (s.conversations[active.activeTabId] ?? active) : active;
}

export function useSessionsStore<T>(selector: (s: SessionsSlice) => T): T {
  return selector(state);
}

useSessionsStore.getState = () => state;
useSessionsStore.subscribe = () => () => {};
