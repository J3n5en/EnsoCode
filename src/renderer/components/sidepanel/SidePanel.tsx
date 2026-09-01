import { useDndMonitor } from '@dnd-kit/core';
import { horizontalListSortingStrategy, SortableContext, useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import type { SidePanelTab, SidePanelTabKind } from '@shared/types/sidePanel';
import { FolderOpen, Globe, Plus, SquareTerminal, X } from 'lucide-react';
import { Menu, MenuItem, MenuPopup, MenuTrigger } from '@/components/ui/menu';
import { useI18n } from '@/i18n';
import { cn } from '@/lib/utils';
import { useSessionsStore } from '@/stores/sessions';
import { useSettingsStore } from '@/stores/settings';
import { useSidePanelStore } from '@/stores/sidePanel';
import { TerminalView } from './TerminalView';

const TAB_PREFIX = 'sptab:';
const tabDragId = (tabId: string): string => `${TAB_PREFIX}${tabId}`;

interface TabDragPayload {
  type: 'side-panel-tab';
  conversationId: string;
  tabId: string;
}

const TAB_ICONS: Record<SidePanelTabKind, typeof SquareTerminal> = {
  terminal: SquareTerminal,
  browser: Globe,
  file: FolderOpen,
};

function SortableTabChip({
  tab,
  conversationId,
  active,
  onSelect,
  onClose,
}: {
  tab: SidePanelTab;
  conversationId: string;
  active: boolean;
  onSelect: () => void;
  onClose: () => void;
}) {
  const Icon = TAB_ICONS[tab.kind];
  const payload: TabDragPayload = { type: 'side-panel-tab', conversationId, tabId: tab.id };
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: tabDragId(tab.id),
    data: payload,
  });
  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={cn(
        'group flex h-7 min-w-0 shrink-0 cursor-default items-center gap-1 rounded-md px-2 text-xs transition-colors',
        active
          ? 'bg-accent text-foreground'
          : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground',
        isDragging && 'opacity-50'
      )}
      onPointerDown={onSelect}
      {...attributes}
      {...listeners}
    >
      <Icon className="h-3.5 w-3.5 shrink-0" />
      <span className="max-w-28 truncate">{tab.title}</span>
      <button
        type="button"
        className="rounded p-0.5 opacity-0 transition-opacity hover:bg-accent group-hover:opacity-100"
        onPointerDown={(e) => e.stopPropagation()}
        onClick={onClose}
      >
        <X className="h-3 w-3" />
      </button>
    </div>
  );
}

function NewTabMenu({ onNewTerminal, compact }: { onNewTerminal: () => void; compact?: boolean }) {
  const { t } = useI18n();
  return (
    <Menu>
      <MenuTrigger
        className={cn(
          'flex items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground',
          compact ? 'h-7 w-7' : 'h-8 gap-1.5 border border-dashed px-3 text-sm hover:border-solid'
        )}
        aria-label={t('New tab')}
      >
        <Plus className="h-4 w-4" />
        {!compact && <span>{t('New tab')}</span>}
      </MenuTrigger>
      <MenuPopup align={compact ? 'end' : 'center'} className="min-w-36">
        <MenuItem onClick={onNewTerminal}>
          <SquareTerminal className="h-4 w-4" />
          {t('Terminal')}
        </MenuItem>
        {/* 预留:浏览器 / 文件,后续实现 */}
        <MenuItem disabled>
          <Globe className="h-4 w-4" />
          {t('Browser')}
          <span className="ml-auto text-[10px] text-muted-foreground">{t('Soon')}</span>
        </MenuItem>
        <MenuItem disabled>
          <FolderOpen className="h-4 w-4" />
          {t('Files')}
          <span className="ml-auto text-[10px] text-muted-foreground">{t('Soon')}</span>
        </MenuItem>
      </MenuPopup>
    </Menu>
  );
}

export function SidePanel({ width }: { width: number }) {
  const { t } = useI18n();
  const conversation = useSessionsStore((s) => (s.activeId ? s.conversations[s.activeId] : null));
  const projects = useSettingsStore((s) => s.projects);
  const tabs = useSidePanelStore((s) => (conversation ? (s.tabs[conversation.id] ?? []) : []));
  const activeTabId = useSidePanelStore((s) =>
    conversation ? s.active[conversation.id] : undefined
  );
  const addTab = useSidePanelStore((s) => s.addTab);
  const closeTab = useSidePanelStore((s) => s.closeTab);
  const selectTab = useSidePanelStore((s) => s.selectTab);
  const moveTab = useSidePanelStore((s) => s.moveTab);

  // 终端 cwd:worktree 目录优先,否则项目目录
  const cwd =
    conversation?.worktree?.path ?? projects.find((p) => p.id === conversation?.projectId)?.path;

  useDndMonitor({
    onDragEnd: (event) => {
      const payload = event.active.data.current as TabDragPayload | undefined;
      if (payload?.type !== 'side-panel-tab' || !event.over) return;
      const overId = String(event.over.id);
      if (!overId.startsWith(TAB_PREFIX)) return;
      moveTab(payload.conversationId, payload.tabId, overId.slice(TAB_PREFIX.length));
    },
  });

  const handleNewTerminal = () => {
    if (!conversation) return;
    const count = tabs.filter((tab) => tab.kind === 'terminal').length;
    addTab(
      conversation.id,
      'terminal',
      count === 0 ? t('Terminal') : `${t('Terminal')} ${count + 1}`
    );
  };

  const activeTab = tabs.find((tab) => tab.id === activeTabId);

  return (
    <div className="flex h-full shrink-0 flex-col border-l bg-background/60" style={{ width }}>
      {conversation && tabs.length > 0 && (
        <div className="flex items-center gap-1 border-b px-2 py-1.5">
          <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
            <SortableContext
              items={tabs.map((tab) => tabDragId(tab.id))}
              strategy={horizontalListSortingStrategy}
            >
              {tabs.map((tab) => (
                <SortableTabChip
                  key={tab.id}
                  tab={tab}
                  conversationId={conversation.id}
                  active={tab.id === activeTabId}
                  onSelect={() => selectTab(conversation.id, tab.id)}
                  onClose={() => closeTab(conversation.id, tab.id)}
                />
              ))}
            </SortableContext>
          </div>
          <NewTabMenu compact onNewTerminal={handleNewTerminal} />
        </div>
      )}

      <div className="min-h-0 flex-1">
        {!conversation ? (
          <div className="flex h-full items-center justify-center px-6 text-center text-sm text-muted-foreground">
            {t('Select a conversation to use the side panel.')}
          </div>
        ) : tabs.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
            <p className="text-sm text-muted-foreground">
              {t('No tabs yet. Create one to get started.')}
            </p>
            <NewTabMenu onNewTerminal={handleNewTerminal} />
          </div>
        ) : (
          activeTab?.kind === 'terminal' && (
            <TerminalView key={activeTab.id} termId={activeTab.id} cwd={cwd} />
          )
        )}
      </div>
    </div>
  );
}
