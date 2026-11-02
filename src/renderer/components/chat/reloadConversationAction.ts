import { addToast } from '@/components/ui/toast';
import type { TFunction } from '@/i18n';
import { useSessionsStore } from '@/stores/sessions';

/**
 * 菜单入口的「重新读取会话」：成功静默（正文自己更新），失败 toast 带原因。
 * Sidebar 会话行与 CoworkerTabs 子会话 tab 共用，保证两处反馈一致。
 */
export async function reloadConversationFromMenu(id: string, t: TFunction): Promise<void> {
  const error = await useSessionsStore.getState().reloadConversation(id);
  if (error) {
    addToast({ type: 'error', title: t('Failed to reload conversation'), description: error });
  }
}

/** 菜单入口的「重启会话」：按当前设置重新 spawn，失败 toast 带原因 */
export async function restartConversationFromMenu(id: string, t: TFunction): Promise<void> {
  const error = await useSessionsStore.getState().restartConversation(id);
  if (error) {
    addToast({ type: 'error', title: t('Failed to restart conversation'), description: error });
  }
}
