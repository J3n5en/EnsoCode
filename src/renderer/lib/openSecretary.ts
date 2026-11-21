import { latestSecretaryConversation } from '@/lib/secretaryEntry';
import { useSecretaryStore } from '@/stores/secretary';
import { useSessionsStore } from '@/stores/sessions';

/**
 * 打开一个秘书：指定了就是它，没指定（折叠侧栏按钮、快捷键）就是最近用过的那个——
 * 所有秘书会话里最近活跃的一条所属的秘书。
 * 有会话就打开最近的（「聊着设置」还没确认档案时也算，否则再点入口又回到欢迎页）；
 * 没有会话时：未完成初次设置进欢迎页，否则新建一个。
 */
export function openSecretary(secretaryId?: string): void {
  const store = useSecretaryStore.getState();
  const sessions = useSessionsStore.getState();
  const candidates = secretaryId
    ? store.secretaries.filter((entry) => entry.id === secretaryId)
    : store.secretaries;
  let best: { id: string; conversationId: string; at: number } | null = null;
  for (const entry of candidates) {
    const conversationId = latestSecretaryConversation(entry.projectId, sessions);
    if (!conversationId) continue;
    const at = sessions.conversations[conversationId]?.lastActiveAt ?? 0;
    if (!best || at > best.at) best = { id: entry.id, conversationId, at };
  }
  if (best) {
    store.focus(best.id);
    sessions.selectConversation(best.conversationId);
    return;
  }
  const id = secretaryId ?? store.focusedId ?? store.secretaries[0]?.id;
  if (!id) return;
  store.focus(id);
  // 刚建好的秘书状态是异步拉的：没到时按清单（没档案时名字为空）判断，不能点了没反应
  const current = useSecretaryStore.getState();
  const state = current.states[id];
  const summary = current.secretaries.find((entry) => entry.id === id);
  if (!(state?.projectId ?? summary?.projectId)) return;
  if (state ? !state.profile : summary?.name == null) {
    useSecretaryStore.getState().openWelcome();
    return;
  }
  void useSecretaryStore.getState().newSecretaryConversation({ secretaryId: id });
}
