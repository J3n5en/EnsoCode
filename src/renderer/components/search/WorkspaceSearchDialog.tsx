import { botBrowserChatId } from '@shared/bots/browser';
import { projectDisplayName } from '@shared/projectName';
import type { BrowserSearchTab, SettingsSearchEntry } from '@shared/searchAnything';
import {
  buildSettingsCatalog,
  recentBrowserTabs,
  searchBrowserTabs,
  searchSettingsEntries,
} from '@shared/searchAnything';
import type { SettingsCategory } from '@shared/settingsDeepLink';
import type { WorkspaceSearchHit, WorkspaceSearchScope } from '@shared/workspaceSearch';
import {
  cycleWorkspaceSearchScope,
  highlightWorkspaceMatches,
  mergeWorkspaceHits,
  searchWorkspace,
} from '@shared/workspaceSearch';
import {
  Bot,
  Globe,
  type LucideIcon,
  MessageCircle,
  Plus,
  Settings as SettingsIcon,
  Zap,
} from 'lucide-react';
import {
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  useEffect,
  useMemo,
  useState,
} from 'react';
import { requestOpenChatFind } from '@/components/chat/ChatFindBar';
import { Badge } from '@/components/ui/badge';
import {
  Command,
  CommandDialog,
  CommandDialogPopup,
  CommandEmpty,
  CommandFooter,
  CommandGroup,
  CommandGroupLabel,
  CommandInput,
  CommandItem,
  CommandList,
  CommandPanel,
  CommandShortcut,
} from '@/components/ui/command';
import { Kbd, KbdGroup } from '@/components/ui/kbd';
import { useI18n } from '@/i18n';
import { effectiveKeybindings, formatBinding } from '@/lib/keybindings';
import { addSidePanelBrowser } from '@/lib/sidePanelDock';
import { formatRelativeTime } from '@/lib/time';
import {
  conversationActivityAt,
  conversationToSearchDoc,
  isDraftEmptyConversation,
  recentConversations,
} from '@/lib/workspaceSearchDocs';
import { useSessionsStore } from '@/stores/sessions';
import { useSettingsStore } from '@/stores/settings';

const NO_HITS: WorkspaceSearchHit[] = [];

const SCOPE_LABELS: Record<WorkspaceSearchScope, string> = {
  project: 'This project',
  all: 'All projects',
  'all-including-archived': 'Include archived',
};

const SETTINGS_CATEGORY_LABELS: Record<SettingsCategory, string> = {
  general: 'General',
  shortcuts: 'Shortcuts',
  appearance: 'Appearance',
  providers: 'Model Providers',
  skills: 'Skills',
  plugins: 'Plugins',
  mcp: 'MCP Servers',
  instructions: 'Instruction Files',
  presets: 'Presets',
  agents: 'Agent types',
  workflows: 'Workflows',
  tools: 'Built-in tools',
  memory: 'Memory',
  phone: 'Devices',
  ssh: 'SSH',
  usage: 'Usage',
  resources: 'Resources',
  voice: 'Voice input',
  experimental: 'Experimental',
  bots: 'Bot mode',
  botTemplates: 'Bot templates',
};

function Highlighted({ text, query }: { text: string; query: string }) {
  let offset = 0;
  return highlightWorkspaceMatches(text, query).map((part) => {
    const key = offset;
    offset += part.text.length;
    return part.match ? (
      <mark key={key} className="rounded-[3px] bg-brand/14 text-foreground">
        {part.text}
      </mark>
    ) : (
      <span key={key}>{part.text}</span>
    );
  });
}

function ResultRow({
  icon: Icon,
  title,
  badges,
  detail,
  meta,
}: {
  icon: LucideIcon;
  title: ReactNode;
  badges?: ReactNode;
  detail?: ReactNode;
  meta?: ReactNode;
}) {
  return (
    <>
      <Icon className="size-4 shrink-0 text-muted-foreground" />
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-1.5">
          <span className="truncate">{title}</span>
          {badges}
        </div>
        {detail && <p className="truncate text-muted-foreground text-xs">{detail}</p>}
      </div>
      {meta && (
        <span className="max-w-48 shrink-0 truncate text-muted-foreground text-xs">{meta}</span>
      )}
    </>
  );
}

function hostOf(url: string): string {
  try {
    return new URL(url).host || url;
  } catch {
    return url;
  }
}

export function WorkspaceSearchDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t, locale } = useI18n();
  const [query, setQuery] = useState('');
  const [scope, setScope] = useState<WorkspaceSearchScope>('all');
  // 冷结果带上发起时的查询键，查询变化后旧结果立即失效，不混进新查询
  const [cold, setCold] = useState<{ key: string; hits: WorkspaceSearchHit[] }>();
  const [browserTabs, setBrowserTabs] = useState<BrowserSearchTab[]>([]);
  const [sshConnections, setSshConnections] = useState<Array<{ id: string; name: string }>>([]);
  const conversations = useSessionsStore((state) => state.conversations);
  const activeId = useSessionsStore((state) => state.activeId);
  const projects = useSettingsStore((state) => state.projects);
  const providers = useSettingsStore((state) => state.providers);
  const skills = useSettingsStore((state) => state.skills);
  const mcpServers = useSettingsStore((state) => state.mcpServers);
  const instructions = useSettingsStore((state) => state.instructions);
  const keybindings = useSettingsStore((state) => state.keybindings);
  const currentProjectId =
    (activeId ? conversations[activeId]?.projectId : undefined) ?? projects[0]?.id ?? '';
  const trimmed = query.trim();
  const coldKey = `${scope}\n${currentProjectId}\n${trimmed}`;
  const coldHits = cold?.key === coldKey ? cold.hits : NO_HITS;

  const docs = useMemo(() => {
    if (!open) return [];
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
        lastActiveAt: conversationActivityAt(conversation),
        archived: conversation.archived,
        isDraftEmpty: isDraftEmptyConversation(conversation),
        isCurrent: conversation.id === currentId,
        parentConversationId: conversation.parentId,
        coworkerId: conversation.parentId ? conversation.id : undefined,
        messages: conversation.messages,
      });
    });
  }, [activeId, conversations, open, projects]);

  const hotHits = useMemo(
    () => (trimmed ? searchWorkspace(docs, query, { currentProjectId, scope }) : NO_HITS),
    [currentProjectId, docs, query, scope, trimmed]
  );

  const recent = useMemo(
    () =>
      open ? recentConversations(Object.values(conversations), { scope, currentProjectId }) : [],
    [conversations, currentProjectId, open, scope]
  );

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
    () =>
      trimmed
        ? searchSettingsEntries(settingsCatalog, query, { translate: (text) => t(text) })
        : [],
    [query, settingsCatalog, t, trimmed]
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
      setScope('all');
      setCold(undefined);
      return;
    }
    void window.electronAPI.browser
      .listSearchableTabs()
      .then((tabs) => setBrowserTabs(tabs.filter((tab) => !botBrowserChatId(tab.conversationId))))
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
  }, [open]);

  useEffect(() => {
    if (!open || !trimmed || !currentProjectId) return;
    let cancelled = false;
    const timer = window.setTimeout(() => {
      void window.electronAPI.workspaceSearch
        .query({ query: trimmed, currentProjectId, scope })
        .then((result) => {
          if (!cancelled) setCold({ key: coldKey, hits: result.hits });
        })
        .catch(() => {
          if (!cancelled) setCold({ key: coldKey, hits: [] });
        });
    }, 80);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [coldKey, currentProjectId, open, scope, trimmed]);

  const hits = useMemo(
    () => mergeWorkspaceHits(docs, hotHits, coldHits, query, { currentProjectId, scope }),
    [coldHits, currentProjectId, docs, hotHits, query, scope]
  );

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

  const onInputKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.key !== 'Tab' || event.nativeEvent.isComposing) {
      closeOnEscape(event);
      return;
    }
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    event.preventDefault();
    setScope((current) => cycleWorkspaceSearchScope(current, event.shiftKey));
  };

  const bindings = effectiveKeybindings(keybindings);
  const now = Date.now();
  const projectNameOf = (projectId: string) => {
    const project = projects.find((item) => item.id === projectId);
    return project ? projectDisplayName(project) : '';
  };
  const metaOf = (projectId: string, at?: number) =>
    [projectNameOf(projectId), at ? formatRelativeTime(at, locale, now) : '']
      .filter(Boolean)
      .join(' · ');
  const statusBadges = (current?: boolean, archived?: boolean) => (
    <>
      {current && (
        <Badge size="sm" className="bg-brand/10 text-brand">
          {t('Current')}
        </Badge>
      )}
      {archived && (
        <Badge variant="outline" size="sm">
          {t('Archived')}
        </Badge>
      )}
    </>
  );

  const hitRow = (hit: WorkspaceSearchHit) => {
    const conversation = conversations[hit.conversationId];
    const parentId = hit.parentConversationId ?? conversation?.parentId;
    let icon: LucideIcon = MessageCircle;
    if (parentId) icon = conversation?.child?.mode === 'task' ? Zap : Bot;
    const title =
      hit.title ||
      conversation?.child?.agentInstanceName ||
      conversation?.coworkerName ||
      t('New conversation');
    const parentTitle = parentId
      ? conversations[parentId]?.title || t('New conversation')
      : undefined;
    const detail =
      hit.field === 'body' || hit.field === 'tool' || hit.field === 'id'
        ? hit.snippet.replace(/\s+/g, ' ').trim()
        : '';
    return (
      <ResultRow
        icon={icon}
        title={
          <>
            {parentTitle && <span className="text-muted-foreground">{parentTitle} › </span>}
            <Highlighted text={title} query={query} />
          </>
        }
        badges={statusBadges(hit.isCurrent, hit.archived)}
        detail={detail && <Highlighted text={detail} query={query} />}
        meta={metaOf(
          hit.projectId,
          conversation ? conversationActivityAt(conversation) : undefined
        )}
      />
    );
  };

  const browserItem = (tab: BrowserSearchTab, key: string) => (
    <CommandItem key={key} value={key} className="gap-2.5" onClick={() => openBrowser(tab)}>
      <ResultRow
        icon={Globe}
        title={<Highlighted text={tab.title || tab.url} query={query} />}
        meta={hostOf(tab.url)}
      />
    </CommandItem>
  );

  const scopeChip = (
    <button
      type="button"
      tabIndex={-1}
      data-search-scope={scope}
      title={t('Switch scope')}
      className="flex h-7 shrink-0 items-center gap-1.5 rounded-md border px-2 text-muted-foreground text-xs transition-colors hover:bg-accent hover:text-foreground"
      onPointerDown={(event) => {
        event.preventDefault();
        event.stopPropagation();
        setScope((current) => cycleWorkspaceSearchScope(current, event.shiftKey));
      }}
    >
      {t(SCOPE_LABELS[scope])}
      <Kbd className="h-4 min-w-4 text-[10px]">⇥</Kbd>
    </button>
  );

  return (
    <CommandDialog open={open} onOpenChange={onOpenChange}>
      <CommandDialogPopup
        className="max-h-[min(36rem,calc(100vh-6rem))] max-w-2xl"
        onKeyDown={closeOnEscape}
      >
        <Command>
          <CommandInput
            placeholder={t('Search conversations, browser tabs, settings…')}
            value={query}
            onChange={(event) => setQuery(event.currentTarget.value)}
            onKeyDown={onInputKeyDown}
            endAddon={scopeChip}
          />
          <CommandPanel>
            {empty && (
              <CommandEmpty>
                {t('No matching results')}
                {scope !== 'all-including-archived' && (
                  <span className="mt-2 flex items-center justify-center gap-1.5 text-xs">
                    <Kbd>⇥</Kbd>
                    {t(scope === 'project' ? 'Search all projects' : 'Include archived')}
                  </span>
                )}
              </CommandEmpty>
            )}
            <CommandList>
              {!trimmed && (
                <>
                  {recent.length > 0 && (
                    <CommandGroup>
                      <CommandGroupLabel>{t('Recent')}</CommandGroupLabel>
                      {recent.map((conversation) => (
                        <CommandItem
                          key={conversation.id}
                          value={`recent-${conversation.id}`}
                          className="gap-2.5"
                          onClick={() =>
                            openHit({
                              conversationId: conversation.id,
                              field: 'title',
                              snippet: conversation.title,
                            })
                          }
                        >
                          <ResultRow
                            icon={MessageCircle}
                            title={conversation.title || t('New conversation')}
                            badges={statusBadges(
                              conversation.id === activeId,
                              conversation.archived
                            )}
                            meta={metaOf(
                              conversation.projectId,
                              conversationActivityAt(conversation)
                            )}
                          />
                        </CommandItem>
                      ))}
                    </CommandGroup>
                  )}
                  {recentBrowsers.length > 0 && (
                    <CommandGroup>
                      <CommandGroupLabel>{t('Browser')}</CommandGroupLabel>
                      {recentBrowsers.map((tab) => browserItem(tab, `recent-browser-${tab.tabId}`))}
                    </CommandGroup>
                  )}
                  <CommandGroup>
                    <CommandGroupLabel>{t('Actions')}</CommandGroupLabel>
                    <CommandItem
                      value="new-conversation"
                      className="gap-2.5"
                      onClick={() => {
                        if (currentProjectId)
                          void useSessionsStore.getState().newConversation(currentProjectId);
                        onOpenChange(false);
                      }}
                    >
                      <ResultRow
                        icon={Plus}
                        title={
                          <>
                            {t('New conversation')}
                            {projectNameOf(currentProjectId) && (
                              <span className="text-muted-foreground">
                                {' · '}
                                {projectNameOf(currentProjectId)}
                              </span>
                            )}
                          </>
                        }
                      />
                      <CommandShortcut>
                        {formatBinding(bindings['new-conversation'])}
                      </CommandShortcut>
                    </CommandItem>
                    <CommandItem
                      value="open-settings"
                      className="gap-2.5"
                      onClick={() => {
                        void window.electronAPI.window.openSettings();
                        onOpenChange(false);
                      }}
                    >
                      <ResultRow icon={SettingsIcon} title={t('Open settings')} />
                      <CommandShortcut>{formatBinding(bindings['open-settings'])}</CommandShortcut>
                    </CommandItem>
                  </CommandGroup>
                </>
              )}
              {trimmed.length > 0 && hits.length > 0 && (
                <CommandGroup>
                  <CommandGroupLabel>{t('Conversations')}</CommandGroupLabel>
                  {hits.map((hit) => (
                    <CommandItem
                      key={`${hit.conversationId}-${hit.field}`}
                      value={`conv-${hit.conversationId}-${hit.field}`}
                      className="gap-2.5"
                      onClick={() => openHit(hit)}
                    >
                      {hitRow(hit)}
                    </CommandItem>
                  ))}
                </CommandGroup>
              )}
              {trimmed.length > 0 && browserHits.length > 0 && (
                <CommandGroup>
                  <CommandGroupLabel>{t('Browser')}</CommandGroupLabel>
                  {browserHits.map((tab) => browserItem(tab, `browser-${tab.tabId}`))}
                </CommandGroup>
              )}
              {trimmed.length > 0 && settingsHits.length > 0 && (
                <CommandGroup>
                  <CommandGroupLabel>{t('Settings')}</CommandGroupLabel>
                  {settingsHits.map((entry) => (
                    <CommandItem
                      key={entry.id}
                      value={`settings-${entry.id}`}
                      className="gap-2.5"
                      onClick={() => openSetting(entry)}
                    >
                      <ResultRow
                        icon={SettingsIcon}
                        title={<Highlighted text={t(entry.title)} query={query} />}
                        detail={
                          entry.description && (
                            <Highlighted text={t(entry.description)} query={query} />
                          )
                        }
                        meta={t(
                          SETTINGS_CATEGORY_LABELS[entry.category as SettingsCategory] ??
                            entry.category
                        )}
                      />
                    </CommandItem>
                  ))}
                </CommandGroup>
              )}
            </CommandList>
          </CommandPanel>
          <CommandFooter>
            <div className="flex items-center gap-4">
              <span className="flex items-center gap-1.5">
                <KbdGroup>
                  <Kbd>↑</Kbd>
                  <Kbd>↓</Kbd>
                </KbdGroup>
                {t('Navigate')}
              </span>
              <span className="flex items-center gap-1.5">
                <Kbd>↵</Kbd>
                {t('Open')}
              </span>
              <span className="flex items-center gap-1.5">
                <Kbd>⇥</Kbd>
                {t('Switch scope')}
              </span>
            </div>
            <span className="flex items-center gap-1.5">
              <Kbd>esc</Kbd>
              {t('Close')}
            </span>
          </CommandFooter>
        </Command>
      </CommandDialogPopup>
    </CommandDialog>
  );
}
