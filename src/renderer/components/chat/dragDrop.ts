/**
 * 侧栏拖拽的路由纯函数与共享契约。
 * DndContext 挂在 App.tsx(Sidebar 与 Composer 的共同祖先),
 * onDragEnd 用 routeDrop 把「谁拖到哪」翻译成动作,由 App 层分发执行。
 */

export const COMPOSER_DROP_ID = 'composer-drop';
export const PINNED_DROP_ID = 'pinned-drop';
const PROJECT_PREFIX = 'project:';

export const projectDragId = (projectId: string): string => `${PROJECT_PREFIX}${projectId}`;
export const chatDragId = (conversationId: string): string => `chat:${conversationId}`;

export type DragPayload =
  | { type: 'project'; projectId: string; path: string; name: string }
  | {
      type: 'chat';
      conversationId: string;
      title: string;
      sessionFile?: string;
      pinned: boolean;
    };

export type DropAction =
  | { kind: 'reorder-projects'; activeId: string; overId: string }
  | { kind: 'insert-file-mention'; path: string; label: string }
  | { kind: 'insert-chat-mention'; conversationId: string; label: string; sessionFile: string }
  | { kind: 'pin-conversation'; conversationId: string };

/** 与 useMentionSearch.toChatMentionCandidates 相同的标题归一:取首行,空回落 */
function chatLabel(title: string): string {
  return title.split('\n')[0].trim() || 'Untitled chat';
}

/**
 * 把拖拽结果翻译成动作;所有不成立的组合返回 null(no-op)。
 * currentConversationId:当前打开的会话,拖入自身输入框不插引用。
 */
export function routeDrop(
  active: DragPayload,
  overId: string | null,
  currentConversationId: string | undefined
): DropAction | null {
  if (!overId) return null;

  if (active.type === 'project') {
    if (overId === COMPOSER_DROP_ID) {
      return { kind: 'insert-file-mention', path: active.path, label: active.name };
    }
    if (overId.startsWith(PROJECT_PREFIX)) {
      const targetId = overId.slice(PROJECT_PREFIX.length);
      if (targetId === active.projectId) return null;
      return { kind: 'reorder-projects', activeId: active.projectId, overId: targetId };
    }
    return null;
  }

  if (overId === COMPOSER_DROP_ID) {
    if (!active.sessionFile) return null;
    if (active.conversationId === currentConversationId) return null;
    return {
      kind: 'insert-chat-mention',
      conversationId: active.conversationId,
      label: chatLabel(active.title),
      sessionFile: active.sessionFile,
    };
  }
  if (overId === PINNED_DROP_ID) {
    if (active.pinned) return null;
    return { kind: 'pin-conversation', conversationId: active.conversationId };
  }
  return null;
}
