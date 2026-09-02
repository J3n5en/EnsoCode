import { useEffect, useRef } from 'react';
import { fileChangeKeys } from '@/lib/fileChangeKeys';
import { addSidePanelChanges } from '@/lib/sidePanelDock';
import type { TimelineItem } from '@/stores/sessions/timeline';
import { useSettingsStore } from '@/stores/settings';

/** 当前会话新完成的 edit/write 时打开 Changes；切换会话只记快照不开面板 */
export function useOpenChangesOnEdit(
  timeline: TimelineItem[],
  conversationId: string | undefined
): void {
  const enabled = useSettingsStore((s) => s.openChangesOnFileEdit);
  const prevId = useRef<string | undefined>(undefined);
  const prevKeys = useRef<Set<string>>(new Set());

  useEffect(() => {
    const keys = fileChangeKeys(timeline);
    if (conversationId !== prevId.current) {
      prevId.current = conversationId;
      prevKeys.current = keys;
      return;
    }
    let added = false;
    for (const key of keys) {
      if (!prevKeys.current.has(key)) added = true;
    }
    prevKeys.current = keys;
    if (added && enabled) addSidePanelChanges();
  }, [conversationId, enabled, timeline]);
}
