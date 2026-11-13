import { latestSecretaryConversation } from '@/lib/secretaryEntry';
import { useSecretaryStore } from '@/stores/secretary';
import { useSessionsStore } from '@/stores/sessions';

/**
 * 有会话就打开最近的（「聊着设置」还没确认档案时也算，否则再点入口又回到欢迎页）；
 * 没有会话时：未完成初次设置进欢迎页，否则新建一个。
 */
export function openSecretary(): void {
  const { secretary, openWelcome, newSecretaryConversation } = useSecretaryStore.getState();
  if (!secretary.projectId) return;
  const sessions = useSessionsStore.getState();
  const target = latestSecretaryConversation(secretary.projectId, sessions);
  if (target) {
    sessions.selectConversation(target);
    return;
  }
  if (!secretary.profile) {
    openWelcome();
    return;
  }
  void newSecretaryConversation();
}
