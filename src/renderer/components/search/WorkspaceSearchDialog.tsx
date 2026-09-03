import type { BrowserSearchTab, SettingsSearchEntry } from '@shared/searchAnything';
import {
  buildSettingsCatalog,
  recentBrowserTabs,
  searchBrowserTabs,
  searchSettingsEntries,
} from '@shared/searchAnything';
import type { WorkspaceSearchHit, WorkspaceSearchScope } from '@shared/workspaceSearch';
import { searchWorkspace } from '@shared/workspaceSearch';
import { type KeyboardEvent as ReactKeyboardEvent, useEffect, useMemo, useState } from 'react';
import { requestOpenChatFind } from '@/components/chat/ChatFindBar';
import {
  Command,
  CommandDialog,
  CommandDialogPopup,
  CommandEmpty,
  CommandGroup,
  CommandGroupLabel,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command';
import { useI18n } from '@/i18n';
import { addSidePanelBrowser } from '@/lib/sidePanelDock';
import { conversationToSearchDoc } from '@/lib/workspaceSearchDocs';
import { useSessionsStore } from '@/stores/sessions';
import { useSettingsStore } from '@/stores/settings';

export function WorkspaceSearchDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useI18n();
  const [query, setQuery] = useState('');
  const [scope, setScope] = useState<WorkspaceSearchScope>('project');
  const [coldHits, setColdHits] = useState<WorkspaceSearchHit[]>([]);
  const [browserTabs, setBrowserTabs] = useState<BrowserSearchTab[]>([]);
  const [sshConnections, setSshConnections] = useState<Array<{ id: string; name: string }>>([]);
  const conversations = useSessionsStore((state) => state.conversations);
  const order = useSessionsStore((state) => state.order);
  const activeId = useSessionsStore((state) => state.activeId);
  const projects = useSettingsStore((state) => state.projects);
  const providers = useSettingsStore((state) => state.providers);
  const skills = useSettingsStore((state) => state.skills);
  const mcpServers = useSettingsStore((state) => state.mcpServers);
  const instructions = useSettingsStore((state) => state.instructions);
  const currentProjectId =
    (activeId ? conversations[activeId]?.projectId : undefined) ?? projects[0]?.id ?? '';

  const docs = useMemo(() => {
    const viewed = activeId ? conversations[activeId] : undefined;
    const viewedChild = viewed?.activeTabId;
    const currentId = viewedChild && conversations[viewedChild] ? viewedChild : activeId;
    return Object.values(conversations).map((conversation) => {
      const project = projects.find((item) => item.id === conversation.projectId);
      return conversationToSearchDoc({
        conversationId: conversation.id,
        projectId: conversation.projectId,
        projectName: project?.name ?? conversation.projectId,
        title: conversation.title,
        lastActiveAt:
          conversation.messages.at(-1)?.timestamp ??
          conversation.lastActiveAt ??
          conversation.createdAt,
        archived: conversation.archived,
        isDraftEmpty: !conversation.started && conversation.messages.length === 0,
        isCurrent: conversation.id === currentId,
        parentConversationId: conversation.parentId,
        coworkerId: conversation.parentId ? conversation.id : undefined,
        messages: conversation.messages,
      });
    });
  }, [activeId, conversations, projects]);

  const hotHits = useMemo(
    () => (query.trim() ? searchWorkspace(docs, query, { currentProjectId, scope }) : []),
    [currentProjectId, docs, query, scope]
  );

  const recent = useMemo(() => {
    return order
      .map((id) => conversations[id])
      .filter((conversation): conversation is NonNullable<typeof conversation> => {
        if (!conversation || conversation.parentId) return false;
        if (conversation.archived && scope !== 'all-including-archived') return false;
        if (scope === 'project' && conversation.projectId !== currentProjectId) return false;
        return conversation.started || conversation.messages.length > 0;
      })
      .slice(0, 8);
  }, [conversations, currentProjectId, order, scope]);

  const settingsCatalog = useMemo(
    () =>
      buildSettingsCatalog({
        providers: providers.map((item) => ({ id: item.id, name: item.name })),
        skills: skills.map((item) => ({ id: item.id, name: item.name })),
        mcpServers: mcpServers.map((item) => ({ id: item.id, name: item.name })),
        instructions: instructions.map((item) => ({ id: item.id, name: item.name })),
        sshConnections,
      }),
    [instructions, mcpServers, providers, skills, sshConnections]
  );

  const settingsHits = useMemo(
    () => (query.trim() ? searchSettingsEntries(settingsCatalog, query) : []),
    [query, settingsCatalog]
  );

  const browserHits = useMemo(
    () => (query.trim() ? searchBrowserTabs(browserTabs, query) : []),
    [browserTabs, query]
  );

  const recentBrowsers = useMemo(() => recentBrowserTabs(browserTabs), [browserTabs]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      onOpenChange(false);
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [onOpenChange, open]);

  useEffect(() => {
    if (!open) {
      setQuery('');
      setColdHits([]);
      return;
    }
    void window.electronAPI.browser
      .listSearchableTabs()
      .then(setBrowserTabs)
      .catch(() => {
        setBrowserTabs([]);
      });
    void window.electronAPI.sshConnections
      .list()
      .then((list) => {
        setSshConnections(list.map((item) => ({ id: item.id, name: item.name })));
      })
      .catch(() => {
        setSshConnections([]);
      });
    const trimmed = query.trim();
    if (!trimmed || !currentProjectId) {
      setColdHits([]);
      return;
    }
    let cancelled = false;
    const timer = window.setTimeout(() => {
      void window.electronAPI.workspaceSearch
        .query({ query: trimmed, currentProjectId, scope })
        .then((result) => {
          if (!cancelled) setColdHits(result.hits);
        })
        .catch(() => {
          if (!cancelled) setColdHits([]);
        });
    }, 80);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [currentProjectId, open, query, scope]);

  const hits = useMemo(() => {
    const seen = new Set(hotHits.map((hit) => hit.conversationId));
    return [...hotHits, ...coldHits.filter((hit) => !seen.has(hit.conversationId))];
  }, [coldHits, hotHits]);

  const openHit = (
    hit: Pick<
      WorkspaceSearchHit,
      'conversationId' | 'parentConversationId' | 'coworkerId' | 'field' | 'snippet'
    >
  ) => {
    const sessions = useSessionsStore.getState();
    const target = sessions.conversations[hit.conversationId];
    const parentId = hit.parentConversationId ?? target?.parentId;
    if (parentId && sessions.conversations[parentId]) {
      sessions.selectConversation(parentId);
      sessions.selectTab(parentId, hit.coworkerId ?? hit.conversationId);
    } else {
      sessions.selectConversation(hit.conversationId);
    }
    onOpenChange(false);
    if (hit.field === 'body' || hit.field === 'tool') {
      const token = query.trim().split(/\s+/).find(Boolean);
      if (token) window.setTimeout(() => requestOpenChatFind(token), 0);
    }
  };

  const openBrowser = (tab: BrowserSearchTab) => {
    const sessions = useSessionsStore.getState();
    const target = sessions.conversations[tab.conversationId];
    const parentId = target?.parentId;
    if (parentId && sessions.conversations[parentId]) {
      sessions.selectConversation(parentId);
      sessions.selectTab(parentId, tab.conversationId);
    } else {
      sessions.selectConversation(tab.conversationId);
    }
    addSidePanelBrowser({
      conversationId: tab.conversationId,
      tabId: tab.tabId,
      title: tab.title || t('Browser'),
    });
    onOpenChange(false);
  };

  const openSetting = (entry: SettingsSearchEntry) => {
    void window.electronAPI.window.openSettings({
      category: entry.category as import('@shared/settingsDeepLink').SettingsCategory,
      rowId: entry.id,
    });
    onOpenChange(false);
  };

  const trimmed = query.trim();
  const empty =
    trimmed.length > 0 &&
    hits.length === 0 &&
    browserHits.length === 0 &&
    settingsHits.length === 0;

  const closeOnEscape = (event: ReactKeyboardEvent | KeyboardEvent) => {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    event.stopPropagation();
    onOpenChange(false);
  };

  const conversationScope = (
    <div
      className="ml-auto flex gap-0.5"
      data-search-scope="conversation"
      onPointerDown={(event) => event.stopPropagation()}
    >
      {(
        [
          ['project', 'This project'],
          ['all', 'All projects'],
          ['all-including-archived', 'Include archived'],
        ] as const
      ).map(([value, label]) => (
        <button
          key={value}
          type="button"
          tabIndex={-1}
          className={`rounded-md px-1.5 py-0.5 text-[10px] ${
            scope === value ? 'bg-accent text-accent-foreground' : 'text-muted-foreground'
          }`}
          onPointerDown={(event) => {
            event.preventDefault();
            event.stopPropagation();
            setScope(value);
          }}
        >
          {t(label)}
        </button>
      ))}
    </div>
  );

  return (
    <CommandDialog open={open} onOpenChange={onOpenChange}>
      <CommandDialogPopup onKeyDown={closeOnEscape}>
        <Command>
          <CommandInput
            placeholder={t('Search anything...')}
            value={query}
            onChange={(event) => setQuery(event.currentTarget.value)}
            onKeyDown={closeOnEscape}
          />
          <CommandList>
            {empty && <CommandEmpty>{t('No matching results')}</CommandEmpty>}
            {!trimmed && (
              <>
                <CommandGroup>
                  <CommandGroupLabel className="flex items-center gap-2">
                    {t('Recent')}
                    {conversationScope}
                  </CommandGroupLabel>
                  {recent.map((conversation) => (
                    <CommandItem
                      key={conversation.id}
                      value={`recent-${conversation.id}`}
                      onClick={() =>
                        openHit({
                          conversationId: conversation.id,
                          field: 'title',
                          snippet: conversation.title,
                        })
                      }
                    >
                      <span className="truncate">{conversation.title}</span>
                    </CommandItem>
                  ))}
                </CommandGroup>
                {recentBrowsers.length > 0 && (
                  <CommandGroup>
                    <CommandGroupLabel>{t('Browser')}</CommandGroupLabel>
                    {recentBrowsers.map((tab) => (
                      <CommandItem
                        key={`recent-browser-${tab.tabId}`}
                        value={`recent-browser-${tab.tabId}`}
                        onClick={() => openBrowser(tab)}
                      >
                        <div className="min-w-0 flex-1">
                          <span className="truncate text-sm">{tab.title || tab.url}</span>
                          <p className="truncate text-xs text-muted-foreground">{tab.url}</p>
                        </div>
                      </CommandItem>
                    ))}
                  </CommandGroup>
                )}
                <CommandGroup>
                  <CommandGroupLabel>{t('Actions')}</CommandGroupLabel>
                  <CommandItem
                    value="new-conversation"
                    onClick={() => {
                      if (currentProjectId)
                        void useSessionsStore.getState().newConversation(currentProjectId);
                      onOpenChange(false);
                    }}
                  >
                    {t('New conversation')}
                  </CommandItem>
                  <CommandItem
                    value="open-settings"
                    onClick={() => {
                      void window.electronAPI.window.openSettings();
                      onOpenChange(false);
                    }}
                  >
                    {t('Open settings')}
                  </CommandItem>
                </CommandGroup>
              </>
            )}
            {trimmed.length > 0 && (
              <CommandGroup>
                <CommandGroupLabel className="flex items-center gap-2">
                  {t('Conversations')}
                  {conversationScope}
                </CommandGroupLabel>
                {hits.map((hit) => (
                  <CommandItem
                    key={`${hit.conversationId}-${hit.field}`}
                    value={`conv-${hit.conversationId}-${hit.field}`}
                    onClick={() => openHit(hit)}
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="truncate text-sm">{hit.title}</span>
                        {hit.isCurrent && (
                          <span className="shrink-0 text-[10px] text-muted-foreground">
                            {t('Current')}
                          </span>
                        )}
                        {hit.archived && (
                          <span className="shrink-0 text-[10px] text-muted-foreground">
                            {t('Archived')}
                          </span>
                        )}
                      </div>
                      <p className="truncate text-xs text-muted-foreground">{hit.snippet}</p>
                    </div>
                  </CommandItem>
                ))}
              </CommandGroup>
            )}
            {trimmed.length > 0 && browserHits.length > 0 && (
              <CommandGroup>
                <CommandGroupLabel>{t('Browser')}</CommandGroupLabel>
                {browserHits.map((tab) => (
                  <CommandItem
                    key={`browser-${tab.tabId}`}
                    value={`browser-${tab.tabId}`}
                    onClick={() => openBrowser(tab)}
                  >
                    <div className="min-w-0 flex-1">
                      <span className="truncate text-sm">{tab.title || tab.url}</span>
                      <p className="truncate text-xs text-muted-foreground">{tab.url}</p>
                    </div>
                  </CommandItem>
                ))}
              </CommandGroup>
            )}
            {trimmed.length > 0 && settingsHits.length > 0 && (
              <CommandGroup>
                <CommandGroupLabel>{t('Settings')}</CommandGroupLabel>
                {settingsHits.map((entry) => (
                  <CommandItem
                    key={entry.id}
                    value={`settings-${entry.id}`}
                    onClick={() => openSetting(entry)}
                  >
                    <div className="min-w-0 flex-1">
                      <span className="truncate text-sm">{t(entry.title)}</span>
                      {entry.description && (
                        <p className="truncate text-xs text-muted-foreground">
                          {t(entry.description)}
                        </p>
                      )}
                    </div>
                  </CommandItem>
                ))}
              </CommandGroup>
            )}
          </CommandList>
        </Command>
      </CommandDialogPopup>
    </CommandDialog>
  );
}
