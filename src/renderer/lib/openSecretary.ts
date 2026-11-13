import { latestSecretaryConversation } from '@/lib/secretaryEntry';
import { useSecretaryStore } from '@/stores/secretary';
import { useSessionsStore } from '@/stores/sessions';

/** 未完成初次设置进欢迎页；否则打开最近的秘书会话，没有会话就新建一个 */
export function openSecretary(): void {
  const { secretary, openWelcome } = useSecretaryStore.getState();
  if (!secretary.profile || !secretary.projectId) {
    openWelcome();
    return;
  }
  const sessions = useSessionsStore.getState();
  const target = latestSecretaryConversation(secretary.projectId, sessions);
  if (target) {
    sessions.selectConversation(target);
    return;
  }
  void sessions.newConversation(secretary.projectId);
}
