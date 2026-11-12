import { useEffect, useRef } from 'react';
import {
  advanceFileChangeBaseline,
  type FileChangeBaseline,
  INITIAL_FILE_CHANGE_BASELINE,
} from '@/lib/fileChangeKeys';
import { addSidePanelChanges } from '@/lib/sidePanelDock';
import { useSessionsStore } from '@/stores/sessions';
import { hasAuthoritativeMessages } from '@/stores/sessions/messageCache';
import type { TimelineItem } from '@/stores/sessions/timeline';
import { useSettingsStore } from '@/stores/settings';

/** 当前会话新完成的 edit/write 时打开 Changes；切换会话只记快照不开面板 */
export function useOpenChangesOnEdit(
  timeline: TimelineItem[],
  conversationId: string | undefined
): void {
  const enabled = useSettingsStore((s) => s.openChangesOnFileEdit);
  // 冷会话正文被清空（或只剩乐观回显）时没有权威历史可占位，基线要等补水后再记
  const authoritative = useSessionsStore((s) =>
    hasAuthoritativeMessages(
      (conversationId ? s.conversations[conversationId]?.messages : undefined) ?? []
    )
  );
  // 时间线 key 用绝对下标：上滑分页或尾窗切全文后基线须重新占位
  const historyBaseIndex = useSessionsStore(
    (s) => (conversationId ? s.conversations[conversationId]?.historyBaseIndex : undefined) ?? 0
  );
  const baseline = useRef<FileChangeBaseline>(INITIAL_FILE_CHANGE_BASELINE);

  useEffect(() => {
    const result = advanceFileChangeBaseline(baseline.current, {
      conversationId,
      historyBaseIndex,
      authoritative,
      timeline,
    });
    baseline.current = result.baseline;
    if (result.added && enabled) addSidePanelChanges();
  }, [authoritative, conversationId, enabled, historyBaseIndex, timeline]);
}
