import {
  type BotTemplateLibrary,
  emptyTemplateLibrary,
  type MemberTemplateData,
  type ResolvedTemplate,
  resolveTemplates,
  type TeamTemplateData,
} from '@shared/bots/templateLibrary';
import { useEffect, useMemo } from 'react';
import { create } from 'zustand';
import { useI18n } from '@/i18n';
import { TEAM_TEMPLATES, teamTemplateData } from './teamTemplates';
import { BOT_TEMPLATES, memberTemplateData } from './templates';

export const BUILTIN_MEMBER_IDS: readonly string[] = BOT_TEMPLATES.map((item) => item.id);
export const BUILTIN_TEAM_IDS: readonly string[] = TEAM_TEMPLATES.map((item) => item.id);

export const useTemplateLibraryStore = create<{ library: BotTemplateLibrary }>(() => ({
  library: emptyTemplateLibrary(),
}));

let started = false;
function ensureLoaded() {
  const api = window.electronAPI?.bots?.templates;
  if (started || !api) return;
  started = true;
  api.onChanged((library) => useTemplateLibraryStore.setState({ library }));
  void api.get().then((result) => {
    if (result.ok) useTemplateLibraryStore.setState({ library: result.library });
  });
}

let queue: Promise<unknown> = Promise.resolve();

/** 基于 Main 上的最新库修改后整体写回；串行执行，避免连续操作互相覆盖 */
export function updateTemplateLibrary(
  mutate: (library: BotTemplateLibrary) => BotTemplateLibrary
): Promise<boolean> {
  const run = queue.then(async () => {
    const api = window.electronAPI.bots.templates;
    const current = await api.get();
    if (!current.ok) return false;
    const result = await api.save(mutate(current.library));
    if (result.ok) useTemplateLibraryStore.setState({ library: result.library });
    return result.ok;
  });
  queue = run.catch(() => false);
  return run;
}

function useLang(): 'zh' | 'en' {
  return useI18n().locale === 'zh' ? 'zh' : 'en';
}

export function useMemberTemplates(includeHidden = false): ResolvedTemplate<MemberTemplateData>[] {
  const lang = useLang();
  const section = useTemplateLibraryStore((s) => s.library.members);
  useEffect(ensureLoaded, []);
  return useMemo(
    () =>
      resolveTemplates(
        BOT_TEMPLATES.map((item) => ({ id: item.id, data: memberTemplateData(item, lang) })),
        section
      ).filter((item) => includeHidden || !item.hidden),
    [section, lang, includeHidden]
  );
}

export function useTeamTemplates(includeHidden = false): ResolvedTemplate<TeamTemplateData>[] {
  const lang = useLang();
  const section = useTemplateLibraryStore((s) => s.library.teams);
  useEffect(ensureLoaded, []);
  return useMemo(
    () =>
      resolveTemplates(
        TEAM_TEMPLATES.map((item) => ({ id: item.id, data: teamTemplateData(item, lang) })),
        section
      ).filter((item) => includeHidden || !item.hidden),
    [section, lang, includeHidden]
  );
}
