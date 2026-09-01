import { useDndContext, useDndMonitor, useDroppable } from '@dnd-kit/core';
import { horizontalListSortingStrategy, SortableContext, useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import type { SidePanelTab, SidePanelTabKind } from '@shared/types/sidePanel';
import { motion } from 'framer-motion';
import { FolderOpen, Globe, PanelRightClose, Plus, SquareTerminal, X } from 'lucide-react';
import { Menu, MenuItem, MenuPopup, MenuTrigger } from '@/components/ui/menu';
import { useI18n } from '@/i18n';
import { springStandard } from '@/lib/motion';
import { cn } from '@/lib/utils';
import { useSessionsStore } from '@/stores/sessions';
import { useSettingsStore } from '@/stores/settings';
import { useSidePanelStore } from '@/stores/sidePanel';
import type { SidePanelGroup } from '@/stores/sidePanel/reducer';
import { TerminalView } from './TerminalView';

const EMPTY_TABS: SidePanelTab[] = [];
const TAB_PREFIX = 'sptab:';
const STRIP_PREFIX = 'sp-strip:';
const SPLIT_ZONE_ID = 'sp-zone:split';
const tabDragId = (tabId: string): string => `${TAB_PREFIX}${tabId}`;

const ICON_BUTTON_CLASS =
  'flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground';

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
  // 选中用 onClick:拖拽未超 6px 阈值时照常触发;onPointerDown 会被展开在后的 dnd listeners 覆盖
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
      onClick={onSelect}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') onSelect();
      }}
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

/** 未分屏时的下半分屏落点:仅当拖拽中的是本面板 tab 且主组不止一个 tab 时出现 */
function SplitDropZone() {
  const { isOver, setNodeRef } = useDroppable({ id: SPLIT_ZONE_ID });
  return (
    <div
      ref={setNodeRef}
      className={cn(
        // 拖拽中即显示虚线提示区,悬停时加强;用蓝色而非 primary:深色终端背景上 primary 几乎不可见
        'absolute inset-x-1 top-1/2 bottom-1 z-10 rounded-md border-2 border-dashed border-blue-400/60 bg-blue-400/10 transition-colors',
        isOver && 'border-solid border-blue-400 bg-blue-400/25'
      )}
    />
  );
}

/** 一个分组:tab 条 + 内容区;tab 条本身是落点(拖入该组末尾) */
function PaneGroup({
  conversationId,
  group,
  tabs,
  activeTabId,
  cwd,
  headerExtra,
  dropHint,
}: {
  conversationId: string;
  group: SidePanelGroup;
  tabs: SidePanelTab[];
  activeTabId: string | undefined;
  cwd?: string;
  headerExtra?: React.ReactNode;
  dropHint?: React.ReactNode;
}) {
  const selectTab = useSidePanelStore((s) => s.selectTab);
  const closeTab = useSidePanelStore((s) => s.closeTab);
  const addTab = useSidePanelStore((s) => s.addTab);
  const { t } = useI18n();
  const strip = useDroppable({ id: `${STRIP_PREFIX}${group}` });
  const activeTab = tabs.find((tab) => tab.id === activeTabId);

  const handleNewTerminal = () => {
    const state = useSidePanelStore.getState();
    const count = [
      ...(state.tabs[conversationId] ?? []),
      ...(state.splitTabs[conversationId] ?? []),
    ].filter((tab) => tab.kind === 'terminal').length;
    addTab(
      conversationId,
      'terminal',
      count === 0 ? t('Terminal') : `${t('Terminal')} ${count + 1}`,
      group
    );
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div
        ref={strip.setNodeRef}
        className={cn(
          'flex items-center gap-1 border-b px-2 py-1.5 transition-colors',
          strip.isOver && 'bg-blue-400/20'
        )}
      >
        <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
          <SortableContext
            items={tabs.map((tab) => tabDragId(tab.id))}
            strategy={horizontalListSortingStrategy}
          >
            {tabs.map((tab) => (
              <SortableTabChip
                key={tab.id}
                tab={tab}
                conversationId={conversationId}
                active={tab.id === activeTabId}
                onSelect={() => selectTab(conversationId, tab.id)}
                onClose={() => closeTab(conversationId, tab.id)}
              />
            ))}
          </SortableContext>
        </div>
        <NewTabMenu compact onNewTerminal={handleNewTerminal} />
        {headerExtra}
      </div>
      <div className="relative min-h-0 flex-1">
        {activeTab?.kind === 'terminal' && (
          <TerminalView key={activeTab.id} termId={activeTab.id} cwd={cwd} />
        )}
        {dropHint}
      </div>
    </div>
  );
}

export function SidePanel({ width, resizing = false }: { width: number; resizing?: boolean }) {
  const { t } = useI18n();
  const open = useSidePanelStore((s) => s.open);
  const toggleOpen = useSidePanelStore((s) => s.toggleOpen);
  const conversation = useSessionsStore((s) => (s.activeId ? s.conversations[s.activeId] : null));
  const projects = useSettingsStore((s) => s.projects);
  // 选择器必须返回稳定引用:兼容 undefined 后在外层回落常量空数组,否则 useSyncExternalStore 死循环
  const tabs =
    useSidePanelStore((s) => (conversation ? s.tabs[conversation.id] : undefined)) ?? EMPTY_TABS;
  const splitTabs =
    useSidePanelStore((s) => (conversation ? s.splitTabs[conversation.id] : undefined)) ??
    EMPTY_TABS;
  const activeTabId = useSidePanelStore((s) =>
    conversation ? s.active[conversation.id] : undefined
  );
  const splitActiveTabId = useSidePanelStore((s) =>
    conversation ? s.splitActive[conversation.id] : undefined
  );
  const addTab = useSidePanelStore((s) => s.addTab);
  const moveTab = useSidePanelStore((s) => s.moveTab);
  const moveTabToGroup = useSidePanelStore((s) => s.moveTabToGroup);

  // 终端 cwd:worktree 目录优先,否则项目目录
  const cwd =
    conversation?.worktree?.path ?? projects.find((p) => p.id === conversation?.projectId)?.path;

  const isSplit = splitTabs.length > 0;

  // 拖拽中的本面板 tab(用于显示分屏落点)
  const { active: dndActive } = useDndContext();
  const draggingTab =
    (dndActive?.data.current as TabDragPayload | undefined)?.type === 'side-panel-tab';

  useDndMonitor({
    onDragEnd: (event) => {
      const payload = event.active.data.current as TabDragPayload | undefined;
      if (payload?.type !== 'side-panel-tab' || !event.over) return;
      const overId = String(event.over.id);
      if (overId.startsWith(TAB_PREFIX)) {
        moveTab(payload.conversationId, payload.tabId, overId.slice(TAB_PREFIX.length));
      } else if (overId === SPLIT_ZONE_ID) {
        moveTabToGroup(payload.conversationId, payload.tabId, 'split');
      } else if (overId.startsWith(STRIP_PREFIX)) {
        moveTabToGroup(
          payload.conversationId,
          payload.tabId,
          overId.slice(STRIP_PREFIX.length) as SidePanelGroup
        );
      }
    },
  });

  const handleNewTerminal = () => {
    if (!conversation) return;
    const count = [...tabs, ...splitTabs].filter((tab) => tab.kind === 'terminal').length;
    addTab(
      conversation.id,
      'terminal',
      count === 0 ? t('Terminal') : `${t('Terminal')} ${count + 1}`
    );
  };

  const collapseButton = (
    <button
      type="button"
      onClick={toggleOpen}
      className={ICON_BUTTON_CLASS}
      title={t('Collapse side panel')}
    >
      <PanelRightClose className="h-4 w-4" />
    </button>
  );

  return (
    <motion.aside
      initial={false}
      animate={{ width: open ? width : 0 }}
      transition={resizing ? { duration: 0 } : springStandard}
      className={cn('flex shrink-0 flex-col overflow-hidden bg-background/60', open && 'border-l')}
    >
      <div className={cn('flex h-full min-h-0 flex-col', !open && 'hidden')} style={{ width }}>
        {!conversation ? (
          <>
            <div className="flex items-center justify-end gap-1 border-b px-2 py-1.5">
              {collapseButton}
            </div>
            <div className="flex flex-1 items-center justify-center px-6 text-center text-sm text-muted-foreground">
              {t('Select a conversation to use the side panel.')}
            </div>
          </>
        ) : tabs.length === 0 && !isSplit ? (
          <>
            <div className="flex items-center justify-end gap-1 border-b px-2 py-1.5">
              {collapseButton}
            </div>
            <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
              <p className="text-sm text-muted-foreground">
                {t('No tabs yet. Create one to get started.')}
              </p>
              <NewTabMenu onNewTerminal={handleNewTerminal} />
            </div>
          </>
        ) : (
          <>
            <PaneGroup
              conversationId={conversation.id}
              group="main"
              tabs={tabs}
              activeTabId={activeTabId}
              cwd={cwd}
              headerExtra={collapseButton}
              dropHint={!isSplit && draggingTab && tabs.length > 1 ? <SplitDropZone /> : undefined}
            />
            {isSplit && (
              <PaneGroup
                conversationId={conversation.id}
                group="split"
                tabs={splitTabs}
                activeTabId={splitActiveTabId}
                cwd={cwd}
              />
            )}
          </>
        )}
      </div>
    </motion.aside>
  );
}
