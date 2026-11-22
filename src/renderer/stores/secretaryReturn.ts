import { create } from 'zustand';
import { useSessionsStore } from '@/stores/sessions';
import { useSettingsStore } from '@/stores/settings';
import { useSessionPeek } from './sessionPeek';

export interface SecretaryReturn {
  /** 发起跳转的秘书会话 */
  from: string;
  /** 跳进的会话（根会话） */
  to: string;
}

/** 从秘书界面跳进别的会话后，目标会话标题栏里的「返回秘书」只认这里记下的来源 */
export const useSecretaryReturn = create<{ back: SecretaryReturn | null }>()(() => ({
  back: null,
}));

function rootOf(id: string): string {
  return useSessionsStore.getState().conversations[id]?.parentId ?? id;
}

function isSecretaryConversation(id: string): boolean {
  const projectId = useSessionsStore.getState().conversations[id]?.projectId;
  return useSettingsStore
    .getState()
    .projects.some((project) => project.id === projectId && project.kind === 'secretary');
}

let watching = false;

/** 离开目标会话（侧栏、标签、别的入口）就收起返回按钮，切回来也不再出现 */
function watchLeave(): void {
  if (watching) return;
  watching = true;
  useSessionsStore.subscribe((state, previous) => {
    if (state.activeId === previous.activeId) return;
    const { back } = useSecretaryReturn.getState();
    if (back && (!state.activeId || rootOf(state.activeId) !== back.to))
      useSecretaryReturn.setState({ back: null });
  });
}

/**
 * 秘书界面里打开某个会话的唯一入口。from 是发起跳转的秘书会话，缺省取当前会话；
 * 来源是秘书会话、目标不是秘书会话时，目标会话里给「返回秘书」。
 */
export function openSessionFromSecretary(conversationId: string, from?: string): void {
  const sessions = useSessionsStore.getState();
  if (!sessions.conversations[conversationId]) return;
  const source = from ?? sessions.activeId;
  const sourceRoot = source ? rootOf(source) : null;
  const to = rootOf(conversationId);
  watchLeave();
  useSessionPeek.getState().close();
  sessions.selectConversation(conversationId);
  useSecretaryReturn.setState({
    back:
      sourceRoot &&
      sourceRoot !== to &&
      isSecretaryConversation(sourceRoot) &&
      !isSecretaryConversation(to)
        ? { from: sourceRoot, to }
        : null,
  });
}

export function returnToSecretary(): void {
  const { back } = useSecretaryReturn.getState();
  if (!back) return;
  useSecretaryReturn.setState({ back: null });
  useSessionsStore.getState().selectConversation(back.from);
}
