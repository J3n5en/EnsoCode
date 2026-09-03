import type { WorkspaceSearchHit, WorkspaceSearchScope } from '@shared/workspaceSearch';
import { searchWorkspace } from '@shared/workspaceSearch';
import { useEffect, useMemo, useState } from 'react';
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
  const conversations = useSessionsStore((state) => state.conversations);
  const order = useSessionsStore((state) => state.order);
  const activeId = useSessionsStore((state) => state.activeId);
  const projects = useSettingsStore((state) => state.projects);
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

  useEffect(() => {
    if (!open) {
      setQuery('');
      setColdHits([]);
      return;
    }
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

  return (
    <CommandDialog open={open} onOpenChange={onOpenChange}>
      <CommandDialogPopup>
        <Command
          items={hits}
          itemToStringValue={(item) => {
            const hit = item as WorkspaceSearchHit;
            return `${hit.title} ${hit.snippet}`;
          }}
        >
          <CommandInput
            placeholder={t('Search conversations...')}
            value={query}
            onChange={(event) => setQuery(event.currentTarget.value)}
          />
          <div className="flex gap-1 px-3 pb-1.5">
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
                className={`rounded-md px-2 py-0.5 text-xs ${
                  scope === value ? 'bg-accent text-accent-foreground' : 'text-muted-foreground'
                }`}
                onClick={() => setScope(value)}
              >
                {t(label)}
              </button>
            ))}
          </div>
          <CommandList>
            <CommandEmpty>{t('No matching conversations')}</CommandEmpty>
            {!query.trim() && (
              <>
                <CommandGroup>
                  <CommandGroupLabel>{t('Recent')}</CommandGroupLabel>
                  {recent.map((conversation) => (
                    <CommandItem
                      key={conversation.id}
                      value={conversation.id}
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
            {query.trim() &&
              hits.map((hit) => (
                <CommandItem
                  key={`${hit.conversationId}-${hit.field}`}
                  value={hit.conversationId}
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
          </CommandList>
        </Command>
      </CommandDialogPopup>
    </CommandDialog>
  );
}
