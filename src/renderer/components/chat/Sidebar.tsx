import {
  DragOverlay,
  useDndContext,
  useDndMonitor,
  useDraggable,
  useDroppable,
} from '@dnd-kit/core';
import { SortableContext, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { ENSO_AGENT_TYPE_KEY } from '@shared/builtinAgents';
import { conversationDotTone } from '@shared/conversationDotTone';
import type { Project } from '@shared/types';
import type { WorktreeStatus } from '@shared/types/worktree';
import { AnimatePresence, motion } from 'framer-motion';
import {
  Archive,
  ArchiveRestore,
  ChevronRight,
  Eraser,
  FileText,
  FolderGit2,
  FolderPlus,
  GitBranch,
  GitBranchPlus,
  HardDriveDownload,
  Loader2,
  MessageSquarePlus,
  PanelLeft,
  PanelLeftClose,
  Pencil,
  Pin,
  PinOff,
  Search,
  Settings,
  Sparkles,
  Trash2,
} from 'lucide-react';
import type * as React from 'react';
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { AddProjectDialog } from '@/components/chat/AddProjectDialog';
import { ConfirmDialog } from '@/components/chat/ConfirmDialog';
import { ConversationTitleEdit } from '@/components/chat/ConversationTitleEdit';
import { matchesQuery } from '@/components/chat/chatSearch';
import { insertComposerMention } from '@/components/chat/composerMentionBridge';
import {
  chatDragId,
  type DragPayload,
  PINNED_DROP_ID,
  pinnedChatDragId,
  projectDragId,
  routeDrop,
} from '@/components/chat/dragDrop';
import { ImportSessionDialog } from '@/components/chat/ImportSessionDialog';
import { NodeSwitcher } from '@/components/nodes/NodeSwitcher';
import {
  ContextMenu,
  ContextMenuItem,
  ContextMenuPopup,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '@/components/ui/context-menu';
import { Input } from '@/components/ui/input';
import { Menu, MenuItem, MenuPopup, MenuTrigger } from '@/components/ui/menu';
import { addToast } from '@/components/ui/toast';
import { useI18n } from '@/i18n';
import { effectiveKeybindings, formatBinding, IS_MAC } from '@/lib/keybindings';
import { heightVariants, springStandard } from '@/lib/motion';
import { formatRelativeTime } from '@/lib/time';
import { cn } from '@/lib/utils';
import { useRemoteNodesStore } from '@/stores/remoteNodes';
import { useSessionsStore } from '@/stores/sessions';
import {
  archivedConversationGroups,
  archivedConversationIds,
  pinnedConversationIds,
  projectConversationIds,
  staleArchivedConversationIds,
} from '@/stores/sessions/pinned';
import {
  COLLAPSED_SESSION_LIMIT,
  sessionSwitchSlotIds,
} from '@/stores/sessions/sessionSwitchSlots';
import { DIRTY_MAIN_TREE, worktreeHasPendingWork } from '@/stores/sessions/worktree';
import { useSettingsStore } from '@/stores/settings';
import { applyProjectOrder, moveProject } from '@/stores/settings/projectOrder';
import {
  ARCHIVED_PROJECTS_KEY,
  PINNED_ORDER_KEY,
  PROJECT_ORDER_KEY,
  readSidebarOrder,
  writeSidebarOrder,
} from '@/stores/settings/sidebarOrderStorage';

const ARCHIVE_PURGE_DAYS = [7, 15, 30] as const;

const ICON_BUTTON_CLASS =
  'flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground';

interface SidebarProps {
  width?: number;
  collapsed: boolean;
  onToggleCollapse: () => void;
  onOpenSearch?: () => void;
}

export function Sidebar({ width, collapsed, onToggleCollapse, onOpenSearch }: SidebarProps) {
  const { t, locale } = useI18n();
  const projects = useSettingsStore((state) => state.projects);
  const keybindings = useSettingsStore((state) => state.keybindings);
  const searchShortcut = formatBinding(effectiveKeybindings(keybindings)['search-workspace']);
  const addProject = useSettingsStore((state) => state.addProject);
  const removeProject = useSettingsStore((state) => state.removeProject);
  const conversations = useSessionsStore((state) => state.conversations);
  const order = useSessionsStore((state) => state.order);
  const activeId = useSessionsStore((state) => state.activeId);
  const newConversation = useSessionsStore((state) => state.newConversation);
  const selectConversation = useSessionsStore((state) => state.selectConversation);
  const removeConversation = useSessionsStore((state) => state.removeConversation);
  const togglePinConversation = useSessionsStore((state) => state.togglePinConversation);
  const toggleArchiveConversation = useSessionsStore((state) => state.toggleArchiveConversation);
  const moveConversationToWorktree = useSessionsStore((state) => state.moveConversationToWorktree);
  const cleanupWorktree = useSessionsStore((state) => state.cleanupWorktree);
  const refreshWorktreeStatuses = useSessionsStore((state) => state.refreshWorktreeStatuses);
  const worktreeStatuses = useSessionsStore((state) => state.worktreeStatuses);

  // 折叠的项目分组（记忆到 localStorage）
  const [collapsedProjects, setCollapsedProjects] = useState<Record<string, boolean>>(() => {
    try {
      return JSON.parse(localStorage.getItem('enso-collapsed-projects') ?? '{}');
    } catch {
      return {};
    }
  });
  const toggleProject = (id: string) => {
    setCollapsedProjects((prev) => {
      const next = { ...prev, [id]: !prev[id] };
      localStorage.setItem('enso-collapsed-projects', JSON.stringify(next));
      return next;
    });
  };

  // 项目自定义顺序(拖拽重排,存 localStorage;新项目追加末尾)
  const [projectOrderIds, setProjectOrderIds] = useState<string[]>(() =>
    readSidebarOrder(PROJECT_ORDER_KEY)
  );
  const orderedProjects = applyProjectOrder(projects, projectOrderIds);

  // 项目归档(项目层标记,存 localStorage):整个项目移到底部 Archived 栏目,
  // 不碰其下会话的 archived/pinned——恢复后会话分布与归档前完全一致,
  // 不会把之前单独归档的会话一并“还原”回项目组
  const [archivedProjectIds, setArchivedProjectIds] = useState<string[]>(() =>
    readSidebarOrder(ARCHIVED_PROJECTS_KEY)
  );
  const toggleArchiveProject = (id: string) => {
    const next = archivedProjectIds.includes(id)
      ? archivedProjectIds.filter((entry) => entry !== id)
      : [...archivedProjectIds, id];
    setArchivedProjectIds(next);
    writeSidebarOrder(ARCHIVED_PROJECTS_KEY, next);
  };
  const activeProjects = orderedProjects.filter(
    (project) => !archivedProjectIds.includes(project.id)
  );
  const activeProjectIds = activeProjects.map((project) => project.id);

  // 置顶组的手动顺序(组内拖拽重排;未收录的新置顶按活跃时间追加)
  const [pinnedOrderIds, setPinnedOrderIds] = useState<string[]>(() =>
    readSidebarOrder(PINNED_ORDER_KEY)
  );

  // 拖拽中的源对象(用于 Overlay 预览与临时 Pinned 落点)
  const { active: dndActive } = useDndContext();
  const dragPayload = dndActive?.data.current as DragPayload | undefined;

  useDndMonitor({
    onDragEnd: (event) => {
      const payload = event.active.data.current as DragPayload | undefined;
      if (!payload) return;
      const overId = event.over ? String(event.over.id) : null;
      const action = routeDrop(payload, overId, activeId ?? undefined);
      if (!action) return;
      switch (action.kind) {
        case 'reorder-projects': {
          const next = moveProject(projects, projectOrderIds, action.activeId, action.overId);
          setProjectOrderIds(next);
          writeSidebarOrder(PROJECT_ORDER_KEY, next);
          break;
        }
        case 'insert-file-mention':
          insertComposerMention({
            kind: 'file',
            id: action.path,
            label: action.label,
            relativePath: action.path,
          });
          break;
        case 'insert-chat-mention':
          insertComposerMention({
            kind: 'chat',
            id: action.conversationId,
            label: action.label,
            sessionFile: action.sessionFile,
          });
          break;
        case 'pin-conversation':
          togglePinConversation(action.conversationId);
          break;
        case 'reorder-pinned': {
          const next = moveProject(
            pinnedIds.map((id) => ({ id })),
            pinnedOrderIds,
            action.activeId,
            action.overId
          );
          setPinnedOrderIds(next);
          writeSidebarOrder(PINNED_ORDER_KEY, next);
          break;
        }
      }
    },
  });

  const [addOpen, setAddOpen] = useState(false);
  const [pendingProject, setPendingProject] = useState<{
    name: string;
    path: string;
    sshHost?: string;
  } | null>(null);
  const handleAddProject = (request: {
    path: string;
    sshConnectionId?: string;
    sshHost?: string;
  }) => {
    if (request.sshConnectionId) {
      setPendingProject({
        name: request.path.split('/').filter(Boolean).pop() ?? request.path,
        path: request.path,
        sshHost: request.sshHost,
      });
    }
    void addProject(
      request.path,
      request.sshConnectionId ? { sshConnectionId: request.sshConnectionId } : undefined
    )
      .then((project) => {
        if (project) void newConversation(project.id);
      })
      .catch((error: unknown) => {
        addToast({
          type: 'error',
          title: t('Failed to add project'),
          description: error instanceof Error ? error.message : String(error),
        });
      })
      .finally(() => setPendingProject(null));
  };

  const [importProject, setImportProject] = useState<Project | null>(null);
  // 待确认的删除动作(项目连带其对话 / 单个对话)
  const [pendingRemove, setPendingRemove] = useState<
    | { kind: 'project'; project: Project; conversationIds: string[] }
    | { kind: 'conversation'; id: string; worktreeWarning?: string }
    | { kind: 'archived'; days: number; conversationIds: string[]; projectName?: string }
    | null
  >(null);
  // 删除隔离会话前先查 worktree 有无未落地成果，确认文案里告知
  const openRemoveConversation = async (id: string) => {
    const conversation = conversations[id];
    let worktreeWarning: string | undefined;
    if (conversation?.worktree) {
      const status = await freshWorktreeStatus(id);
      if (worktreeHasPendingWork(status)) worktreeWarning = worktreeWarningText(status);
    }
    setPendingRemove({ kind: 'conversation', id, worktreeWarning });
  };
  // 展开显示全部会话的项目(会话级状态,重启回到折叠)
  const [expandedProjects, setExpandedProjects] = useState<Record<string, boolean>>({});
  const [listQuery, setListQuery] = useState('');
  const [modHeld, setModHeld] = useState(false);

  const pinnedIds = pinnedConversationIds(order, conversations, pinnedOrderIds, archivedProjectIds);
  const archivedIds = archivedConversationIds(order, conversations, archivedProjectIds);
  const archivedGroups = archivedConversationGroups(
    order,
    conversations,
    orderedProjects.map((project) => project.id),
    archivedProjectIds
  );
  const searching = listQuery.trim().length > 0;
  const convMatches = (id: string) =>
    matchesQuery(listQuery, [conversations[id]?.title || t('New conversation')]);
  const switchSlots = sessionSwitchSlotIds({
    order,
    conversations,
    pinnedOrderIds,
    projectIds: activeProjectIds,
    archivedProjectIds,
    collapsedProjects,
    expandedProjects,
    searching,
    matches: convMatches,
    projectMatches: (projectId) => {
      const project = orderedProjects.find((item) => item.id === projectId);
      return Boolean(project && matchesQuery(listQuery, [project.name, project.path]));
    },
  });
  const switchSlotsRef = useRef(switchSlots);
  switchSlotsRef.current = switchSlots;
  const visiblePinnedIds = searching ? pinnedIds.filter(convMatches) : pinnedIds;
  const visiblePinnedSet = new Set(visiblePinnedIds);
  const switchHintFor = (id: string, surface: 'pinned' | 'project') => {
    if (collapsed || !modHeld) return undefined;
    const index = switchSlots.indexOf(id);
    if (index < 0) return undefined;
    const pinnedVisible = visiblePinnedSet.has(id);
    if (pinnedVisible !== (surface === 'pinned')) return undefined;
    return formatBinding(`mod+${index + 1}`);
  };
  // 搜索时:归档项目名命中则整组保留(与活动项目一致),否则只留命中的会话
  const visibleArchivedGroups = searching
    ? archivedGroups
        .map((group) => {
          const project = projects.find((item) => item.id === group.projectId);
          const projectHit =
            group.projectArchived === true &&
            Boolean(project && matchesQuery(listQuery, [project.name, project.path]));
          return projectHit ? group : { ...group, ids: group.ids.filter(convMatches) };
        })
        .filter((group) => group.ids.length > 0)
    : archivedGroups;
  // 底部「已归档」栏目的折叠态(缺省收起,重启回到收起)
  const [archivedOpen, setArchivedOpen] = useState(false);
  const [archiveCleanupOpen, setArchiveCleanupOpen] = useState<string | null>(null);

  // 相对时间每分钟自刷（“3 分钟前”不随时间僵住）
  const [nowTick, setNowTick] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNowTick(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const mod = IS_MAC ? e.metaKey : e.ctrlKey;
      const switchMode = mod && !e.shiftKey && !e.altKey;
      setModHeld(switchMode);
      if (!switchMode || e.repeat) return;
      if (useRemoteNodesStore.getState().activeNodeId !== 'local') return;
      const n = Number(e.key);
      if (n < 1 || n > 9) return;
      const id = switchSlotsRef.current[n - 1];
      if (!id) return;
      e.preventDefault();
      selectConversation(id);
    };
    const onKeyUp = (e: KeyboardEvent) => {
      const mod = IS_MAC ? e.metaKey : e.ctrlKey;
      setModHeld(mod && !e.shiftKey && !e.altKey);
    };
    const clear = () => setModHeld(false);
    const onVis = () => {
      if (document.hidden) clear();
    };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', clear);
    document.addEventListener('visibilitychange', onVis);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', clear);
      document.removeEventListener('visibilitychange', onVis);
    };
  }, [selectConversation]);

  // worktree 徽标状态：挂载 + 窗口聚焦 + 30s 轻量轮询（只查隔离会话，不每帧跑 git）
  useEffect(() => {
    void refreshWorktreeStatuses();
    const timer = setInterval(() => void refreshWorktreeStatuses(), 30_000);
    const onFocus = () => void refreshWorktreeStatuses();
    window.addEventListener('focus', onFocus);
    return () => {
      clearInterval(timer);
      window.removeEventListener('focus', onFocus);
    };
  }, [refreshWorktreeStatuses]);

  // 隔离会话有未落地成果时的清理/归档拦截确认
  const [pendingWorktreeAction, setPendingWorktreeAction] = useState<{
    kind: 'cleanup' | 'archive';
    id: string;
    status?: WorktreeStatus;
  } | null>(null);
  // 主树有未提交改动时的切隔离二次确认（改动不会丢，只是不跟随会话）
  const [pendingDirtyMove, setPendingDirtyMove] = useState<string | null>(null);

  const freshWorktreeStatus = async (id: string): Promise<WorktreeStatus | undefined> => {
    const result = await window.electronAPI.worktree.status(id);
    return result.ok ? result.value : undefined;
  };

  const runCleanup = async (id: string, archiveAfter: boolean) => {
    const error = await cleanupWorktree(id);
    if (error) {
      addToast({ type: 'error', title: t('Failed to clean up worktree'), description: error });
      return;
    }
    if (archiveAfter) toggleArchiveConversation(id);
    void refreshWorktreeStatuses();
  };

  const handleCleanupWorktree = async (id: string) => {
    const status = await freshWorktreeStatus(id);
    if (worktreeHasPendingWork(status)) {
      setPendingWorktreeAction({ kind: 'cleanup', id, status });
      return;
    }
    await runCleanup(id, false);
  };

  const handleToggleArchive = async (id: string) => {
    const conversation = conversations[id];
    if (!conversation) return;
    // 只有「归档隔离会话」需要拦截；取消归档/本地会话直接走
    if (conversation.archived || !conversation.worktree) {
      toggleArchiveConversation(id);
      return;
    }
    const status = await freshWorktreeStatus(id);
    if (worktreeHasPendingWork(status)) {
      setPendingWorktreeAction({ kind: 'archive', id, status });
      return;
    }
    await runCleanup(id, true);
  };

  // 批量归档：顺序执行，复用单条归档的 worktree 处理逻辑
  const handleArchiveMany = async (ids: string[]) => {
    for (const id of ids) {
      if (!conversations[id] || conversations[id].archived) continue;
      await handleToggleArchive(id);
    }
  };

  const handleMoveToWorktree = async (id: string, allowDirtyMainTree = false) => {
    const error = await moveConversationToWorktree(id, { allowDirtyMainTree });
    if (error === DIRTY_MAIN_TREE) {
      setPendingDirtyMove(id);
      return;
    }
    if (error) {
      addToast({ type: 'error', title: t('Failed to move to worktree'), description: error });
      return;
    }
    void refreshWorktreeStatuses();
  };

  const worktreeWarningText = (status?: WorktreeStatus): string => {
    const parts: string[] = [];
    if (status?.dirty) parts.push(t('uncommitted changes will be lost'));
    if (status && status.ahead > 0)
      parts.push(t('{{n}} unmerged commits (branch is kept)', { n: status.ahead }));
    return parts.join('; ');
  };

  return (
    <motion.aside
      initial={false}
      animate={{ width: collapsed ? 48 : width }}
      transition={springStandard}
      className="flex shrink-0 flex-col overflow-hidden border-r bg-background"
    >
      {collapsed && (
        <div className="flex w-12 flex-1 flex-col items-center gap-1 py-2">
          <button
            type="button"
            onClick={onOpenSearch}
            className={ICON_BUTTON_CLASS}
            title={`${t('Search anything')} (${searchShortcut})`}
          >
            <Search className="h-4 w-4" />
          </button>
          <button
            type="button"
            onClick={() => setAddOpen(true)}
            className={ICON_BUTTON_CLASS}
            title={t('Add project')}
          >
            <FolderPlus className="h-4 w-4" />
          </button>
          <div className="flex-1" />
          <button
            type="button"
            onClick={onToggleCollapse}
            className={ICON_BUTTON_CLASS}
            title={t('Expand sidebar')}
          >
            <PanelLeft className="h-4 w-4" />
          </button>
          <button
            type="button"
            onClick={() => {
              void window.electronAPI.window.summonAgent({ typeKey: ENSO_AGENT_TYPE_KEY });
            }}
            className={ICON_BUTTON_CLASS}
            title={t('Ask Enso')}
          >
            <Sparkles className="h-4 w-4" />
          </button>
          <button
            type="button"
            onClick={() => window.electronAPI.window.openSettings()}
            className={ICON_BUTTON_CLASS}
            title={t('Settings')}
          >
            <Settings className="h-4 w-4" />
          </button>
        </div>
      )}
      <div className={cn('flex h-full min-h-0 flex-col', collapsed && 'hidden')} style={{ width }}>
        <div className="flex h-12 shrink-0 items-center justify-between border-b pr-3 pl-1.5">
          {/* 节点切换器：本机 / 已连的远程 EnsoCode 桌面 */}
          <NodeSwitcher />
          <div className="flex items-center">
            <button
              type="button"
              onClick={onOpenSearch}
              className={ICON_BUTTON_CLASS}
              title={`${t('Search anything')} (${searchShortcut})`}
            >
              <Search className="h-4 w-4" />
            </button>
            <button
              type="button"
              onClick={() => setAddOpen(true)}
              className={ICON_BUTTON_CLASS}
              title={t('Add project')}
            >
              <FolderPlus className="h-4 w-4" />
            </button>
          </div>
        </div>
        <div className="shrink-0 border-b px-2 py-2">
          <div className="relative">
            <Search className="pointer-events-none absolute top-1/2 left-2.5 z-10 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={listQuery}
              onChange={(e) => setListQuery(e.target.value)}
              placeholder={t('Search conversations...')}
              className="h-8 text-xs [&_input]:pl-8"
            />
          </div>
        </div>

        <div className="min-h-0 flex-1 space-y-1 overflow-y-auto p-2">
          {projects.length === 0 && (
            <button
              type="button"
              onClick={() => setAddOpen(true)}
              className="w-full rounded-lg border border-dashed px-3 py-6 text-center text-sm text-muted-foreground transition-colors hover:border-ring hover:text-foreground"
            >
              {t('Add a project to start')}
            </button>
          )}
          {/* 无置顶会话时,拖动会话中露出临时落点条 */}
          {pinnedIds.length === 0 && dragPayload?.type === 'chat' && !dragPayload.pinned && (
            <PinnedDropZone>
              <div className="flex items-center justify-center gap-1.5 rounded-lg border border-dashed px-2 py-2 text-xs text-muted-foreground">
                <Pin className="h-3.5 w-3.5" />
                {t('Drop here to pin')}
              </div>
            </PinnedDropZone>
          )}
          {visiblePinnedIds.length > 0 && (
            <PinnedDropZone data-slot="pinned-section">
              <div className="flex items-center gap-1 px-2 py-2">
                {/* 与项目行同宽的 chevron 占位,让标题与项目名对齐 */}
                <span className="h-5 w-5 shrink-0" />
                <Pin className="h-4 w-4 shrink-0 text-muted-foreground" />
                <span className="text-sm font-medium">{t('Pinned')}</span>
              </div>
              <div className="flex flex-col gap-y-0.5">
                <SortableContext
                  items={visiblePinnedIds.map((id) => pinnedChatDragId(id))}
                  strategy={verticalListSortingStrategy}
                >
                  {visiblePinnedIds.map((id) => (
                    <SortablePinnedChat key={id} id={id} conversation={conversations[id]}>
                      <ConversationRow
                        id={id}
                        conversation={conversations[id]}
                        active={activeId === id}
                        switchHint={switchHintFor(id, 'pinned')}
                        locale={locale}
                        nowTick={nowTick}
                        hoverTitle={
                          projects.find((p) => p.id === conversations[id].projectId)?.name
                        }
                        worktreeStatus={
                          conversations[id].worktree ? worktreeStatuses[id] : undefined
                        }
                        isolated={Boolean(conversations[id].worktree)}
                        onSelect={selectConversation}
                        onTogglePin={togglePinConversation}
                        onToggleArchive={(conversationId) =>
                          void handleToggleArchive(conversationId)
                        }
                        onCleanupWorktree={(conversationId) =>
                          void handleCleanupWorktree(conversationId)
                        }
                        onMoveToWorktree={(conversationId) =>
                          void handleMoveToWorktree(conversationId)
                        }
                        onRemove={(conversationId) => void openRemoveConversation(conversationId)}
                      />
                    </SortablePinnedChat>
                  ))}
                </SortableContext>
              </div>
            </PinnedDropZone>
          )}
          {pendingProject && (
            <div className="flex w-full items-center gap-1 rounded-lg px-2 py-2 text-muted-foreground">
              <span className="flex h-5 w-5 shrink-0 items-center justify-center">
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              </span>
              <FolderGit2 className="h-4 w-4 shrink-0" />
              <span
                className="min-w-0 flex-1 truncate text-sm font-medium"
                title={pendingProject.path}
              >
                {pendingProject.name}
                {pendingProject.sshHost && (
                  <span className="ml-1.5 rounded bg-muted px-1 py-0.5 text-[10px] font-normal">
                    {pendingProject.sshHost}
                  </span>
                )}
              </span>
              <span className="shrink-0 text-xs">{t('Adding...')}</span>
            </div>
          )}
          <SortableContext
            items={activeProjectIds.map((id) => projectDragId(id))}
            strategy={verticalListSortingStrategy}
          >
            {activeProjects.map((project) => {
              const projectConversations = projectConversationIds(order, conversations, project.id);
              const projectHit = matchesQuery(listQuery, [project.name, project.path]);
              const visibleConversations =
                !searching || projectHit
                  ? projectConversations
                  : projectConversations.filter(convMatches);
              if (searching && visibleConversations.length === 0) return null;
              const folded = searching ? false : collapsedProjects[project.id] === true;
              return (
                <SortableProject key={project.id} project={project}>
                  {(drag) => (
                    <div ref={drag.setNodeRef} style={drag.style}>
                      {/* 项目行：chevron 槽 + 仓库图标 + 名称 + 常驻操作（EnsoAI 尺寸）；整行可拖拽排序 */}
                      <div
                        className="group flex w-full items-center gap-1 rounded-lg px-2 py-2 transition-colors hover:bg-accent/30"
                        {...drag.handleProps}
                      >
                        <button
                          type="button"
                          onClick={() => toggleProject(project.id)}
                          className="flex min-w-0 flex-1 items-center gap-1 text-left"
                          title={project.path}
                        >
                          <span className="flex h-5 w-5 shrink-0 items-center justify-center">
                            <ChevronRight
                              className={cn(
                                'h-3.5 w-3.5 text-muted-foreground transition-transform duration-200',
                                !folded && 'rotate-90'
                              )}
                            />
                          </span>
                          <FolderGit2 className="h-4 w-4 shrink-0 text-muted-foreground" />
                          <span
                            className="min-w-0 flex-1 truncate text-sm font-medium"
                            title={
                              project.kind === 'ssh'
                                ? `${project.sshHost}:${project.path}`
                                : project.path
                            }
                          >
                            {project.name}
                            {project.kind === 'ssh' && (
                              <span className="ml-1.5 rounded bg-muted px-1 py-0.5 text-[10px] font-normal text-muted-foreground">
                                {project.sshConnectionName ?? project.sshHost}
                              </span>
                            )}
                          </span>
                        </button>
                        <button
                          type="button"
                          onClick={() => void newConversation(project.id)}
                          className="shrink-0 rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
                          title={t('New conversation')}
                        >
                          <MessageSquarePlus className="h-3.5 w-3.5" />
                        </button>
                        <button
                          type="button"
                          onClick={() => setImportProject(project)}
                          className="shrink-0 rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
                          title={t('Import session')}
                        >
                          <HardDriveDownload className="h-3.5 w-3.5" />
                        </button>
                        <button
                          type="button"
                          onClick={() => toggleArchiveProject(project.id)}
                          className="shrink-0 rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
                          title={t('Archive project')}
                        >
                          <Archive className="h-3.5 w-3.5" />
                        </button>
                        <button
                          type="button"
                          onClick={() =>
                            setPendingRemove({
                              kind: 'project',
                              project,
                              conversationIds: projectConversations,
                            })
                          }
                          className="shrink-0 rounded p-1 text-muted-foreground hover:bg-muted hover:text-destructive"
                          title={t('Remove project')}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      </div>
                      <AnimatePresence initial={false}>
                        {!folded && (
                          <motion.div
                            initial="initial"
                            animate="animate"
                            exit="exit"
                            variants={heightVariants}
                            transition={springStandard}
                            className="overflow-hidden"
                          >
                            <div className="mt-0.5 flex flex-col gap-y-0.5">
                              {(searching || expandedProjects[project.id]
                                ? visibleConversations
                                : visibleConversations.slice(0, COLLAPSED_SESSION_LIMIT)
                              ).map((id) => (
                                <motion.div key={id} layout="position" transition={springStandard}>
                                  <DraggableChat id={id} conversation={conversations[id]}>
                                    <ConversationRow
                                      id={id}
                                      conversation={conversations[id]}
                                      active={activeId === id}
                                      switchHint={switchHintFor(id, 'project')}
                                      locale={locale}
                                      nowTick={nowTick}
                                      worktreeStatus={
                                        conversations[id].worktree
                                          ? worktreeStatuses[id]
                                          : undefined
                                      }
                                      isolated={Boolean(conversations[id].worktree)}
                                      onSelect={selectConversation}
                                      onTogglePin={togglePinConversation}
                                      onToggleArchive={(conversationId) =>
                                        void handleToggleArchive(conversationId)
                                      }
                                      onCleanupWorktree={(conversationId) =>
                                        void handleCleanupWorktree(conversationId)
                                      }
                                      onMoveToWorktree={(conversationId) =>
                                        void handleMoveToWorktree(conversationId)
                                      }
                                      onRemove={(conversationId) =>
                                        void openRemoveConversation(conversationId)
                                      }
                                    />
                                  </DraggableChat>
                                </motion.div>
                              ))}
                              {!searching &&
                                projectConversations.length > COLLAPSED_SESSION_LIMIT && (
                                  <ContextMenu>
                                    <ContextMenuTrigger
                                      render={
                                        (
                                          <button
                                            type="button"
                                            onClick={() =>
                                              setExpandedProjects((prev) => ({
                                                ...prev,
                                                [project.id]: !prev[project.id],
                                              }))
                                            }
                                            className="rounded-lg py-1 text-center text-xs text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground"
                                          >
                                            {expandedProjects[project.id]
                                              ? t('Collapse')
                                              : t('Show {{n}} more', {
                                                  n:
                                                    projectConversations.length -
                                                    COLLAPSED_SESSION_LIMIT,
                                                })}
                                          </button>
                                        ) as React.ReactElement<Record<string, unknown>>
                                      }
                                    />
                                    <ContextMenuPopup className="min-w-36">
                                      <ContextMenuItem
                                        onClick={() =>
                                          void handleArchiveMany(
                                            projectConversations.slice(COLLAPSED_SESSION_LIMIT)
                                          )
                                        }
                                      >
                                        <Archive />
                                        {t('Archive {{n}} conversations', {
                                          n: projectConversations.length - COLLAPSED_SESSION_LIMIT,
                                        })}
                                      </ContextMenuItem>
                                    </ContextMenuPopup>
                                  </ContextMenu>
                                )}
                              {visibleConversations.length === 0 && (
                                <p className="py-1.5 pl-10 text-xs text-muted-foreground">
                                  {t('No conversations yet')}
                                </p>
                              )}
                            </div>
                          </motion.div>
                        )}
                      </AnimatePresence>
                    </div>
                  )}
                </SortableProject>
              );
            })}
          </SortableContext>
        </div>

        {(searching ? visibleArchivedGroups : archivedGroups).length > 0 && (
          <div data-slot="archived-section" className="shrink-0 border-t p-2">
            {/* 列表在折叠头上方：固定底部向上展开 */}
            <AnimatePresence initial={false}>
              {(searching || archivedOpen) && (
                <motion.div
                  initial="initial"
                  animate="animate"
                  exit="exit"
                  variants={heightVariants}
                  transition={springStandard}
                  className="overflow-hidden"
                >
                  <div className="mb-0.5 flex max-h-72 flex-col gap-y-1.5 overflow-y-auto">
                    {visibleArchivedGroups.map((group) => {
                      const projectName =
                        projects.find((project) => project.id === group.projectId)?.name ??
                        t('Other');
                      return (
                        <div key={group.projectId}>
                          <div className="group flex items-center gap-1 rounded-md pr-0.5">
                            {group.projectArchived && (
                              <FolderGit2 className="ml-2 h-3 w-3 shrink-0 text-muted-foreground" />
                            )}
                            <span
                              className={cn(
                                'min-w-0 flex-1 truncate py-1 text-[10px] font-medium tracking-wide text-muted-foreground uppercase',
                                group.projectArchived ? 'px-1' : 'px-2'
                              )}
                            >
                              {projectName}
                            </span>
                            <span className="shrink-0 text-[10px] text-muted-foreground">
                              {group.ids.length}
                            </span>
                            {group.projectArchived ? (
                              <button
                                type="button"
                                onClick={() => toggleArchiveProject(group.projectId)}
                                className="shrink-0 rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
                                title={t('Unarchive project')}
                              >
                                <ArchiveRestore className="h-3.5 w-3.5" />
                              </button>
                            ) : (
                              <ArchiveCleanupMenu
                                open={archiveCleanupOpen === group.projectId}
                                onOpenChange={(open) =>
                                  setArchiveCleanupOpen(open ? group.projectId : null)
                                }
                                idsForDays={(days) =>
                                  staleArchivedConversationIds(
                                    order,
                                    conversations,
                                    days,
                                    Date.now(),
                                    group.projectId
                                  )
                                }
                                onPick={(days, ids) =>
                                  setPendingRemove({
                                    kind: 'archived',
                                    days,
                                    conversationIds: ids,
                                    projectName,
                                  })
                                }
                              />
                            )}
                          </div>
                          <div className="flex flex-col gap-y-0.5">
                            {group.ids.map((id) => (
                              <motion.div key={id} layout="position" transition={springStandard}>
                                <DraggableChat id={id} conversation={conversations[id]}>
                                  <ConversationRow
                                    id={id}
                                    conversation={conversations[id]}
                                    active={activeId === id}
                                    locale={locale}
                                    nowTick={nowTick}
                                    worktreeStatus={
                                      conversations[id].worktree ? worktreeStatuses[id] : undefined
                                    }
                                    isolated={Boolean(conversations[id].worktree)}
                                    onSelect={selectConversation}
                                    onTogglePin={togglePinConversation}
                                    onToggleArchive={(conversationId) =>
                                      void handleToggleArchive(conversationId)
                                    }
                                    onCleanupWorktree={(conversationId) =>
                                      void handleCleanupWorktree(conversationId)
                                    }
                                    onMoveToWorktree={(conversationId) =>
                                      void handleMoveToWorktree(conversationId)
                                    }
                                    onRemove={(conversationId) =>
                                      void openRemoveConversation(conversationId)
                                    }
                                  />
                                </DraggableChat>
                              </motion.div>
                            ))}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
            <div className="group flex items-center gap-1 rounded-lg pr-1 transition-colors hover:bg-accent/30">
              <button
                type="button"
                onClick={() => setArchivedOpen((open) => !open)}
                className="flex min-w-0 flex-1 items-center gap-1 px-2 py-2 text-left"
              >
                <span className="flex h-5 w-5 shrink-0 items-center justify-center">
                  <ChevronRight
                    className={cn(
                      'h-3.5 w-3.5 text-muted-foreground transition-transform duration-200',
                      archivedOpen ? '-rotate-90' : 'rotate-0'
                    )}
                  />
                </span>
                <Archive className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1 truncate text-sm text-muted-foreground">
                  {t('Archived')}
                </span>
                <span className="shrink-0 text-[10px] text-muted-foreground">
                  {archivedIds.length}
                </span>
              </button>
              <ArchiveCleanupMenu
                open={archiveCleanupOpen === '*'}
                onOpenChange={(open) => setArchiveCleanupOpen(open ? '*' : null)}
                idsForDays={(days) =>
                  staleArchivedConversationIds(order, conversations, days, Date.now())
                }
                onPick={(days, ids) =>
                  setPendingRemove({ kind: 'archived', days, conversationIds: ids })
                }
              />
            </div>
          </div>
        )}

        <div className="flex shrink-0 items-center justify-between border-t p-2">
          <button
            type="button"
            onClick={onToggleCollapse}
            className={ICON_BUTTON_CLASS}
            title={t('Collapse sidebar')}
          >
            <PanelLeftClose className="h-4 w-4" />
          </button>
          <div className="flex items-center">
            <button
              type="button"
              onClick={() => {
                void window.electronAPI.window.summonAgent({ typeKey: ENSO_AGENT_TYPE_KEY });
              }}
              className={ICON_BUTTON_CLASS}
              title={t('Ask Enso')}
            >
              <Sparkles className="h-4 w-4" />
            </button>
            <button
              type="button"
              onClick={() => window.electronAPI.window.openSettings()}
              className={ICON_BUTTON_CLASS}
              title={t('Settings')}
            >
              <Settings className="h-4 w-4" />
            </button>
          </div>
        </div>
      </div>

      <AddProjectDialog open={addOpen} onOpenChange={setAddOpen} onAdd={handleAddProject} />
      <ImportSessionDialog project={importProject} onClose={() => setImportProject(null)} />
      <ConfirmDialog
        open={pendingWorktreeAction !== null}
        onOpenChange={(open) => {
          if (!open) setPendingWorktreeAction(null);
        }}
        title={
          pendingWorktreeAction?.kind === 'archive'
            ? t('Archive session and clean up worktree?')
            : t('Clean up worktree?')
        }
        description={t(
          'The isolated worktree has unfinished work: {{warning}}. The session falls back to the main working tree.',
          { warning: worktreeWarningText(pendingWorktreeAction?.status) }
        )}
        confirmLabel={pendingWorktreeAction?.kind === 'archive' ? t('Archive') : t('Clean up')}
        onConfirm={() => {
          if (!pendingWorktreeAction) return;
          void runCleanup(pendingWorktreeAction.id, pendingWorktreeAction.kind === 'archive');
        }}
      />
      <ConfirmDialog
        open={pendingDirtyMove !== null}
        onOpenChange={(open) => {
          if (!open) setPendingDirtyMove(null);
        }}
        title={t('Main working tree has uncommitted changes')}
        description={t(
          'The new worktree branches off HEAD, so those changes stay in the main working tree and will not follow this session.'
        )}
        confirmLabel={t('Move anyway')}
        onConfirm={() => {
          if (!pendingDirtyMove) return;
          const id = pendingDirtyMove;
          setPendingDirtyMove(null);
          void handleMoveToWorktree(id, true);
        }}
      />
      <ConfirmDialog
        open={pendingRemove !== null}
        onOpenChange={(open) => {
          if (!open) setPendingRemove(null);
        }}
        title={
          pendingRemove?.kind === 'project'
            ? t('Remove project?')
            : pendingRemove?.kind === 'archived'
              ? t('Delete archived conversations?')
              : t('Delete conversation?')
        }
        description={
          pendingRemove?.kind === 'project'
            ? t('"{{name}}" and its {{count}} conversations will be removed from the list.', {
                name: pendingRemove.project.name,
                count: pendingRemove.conversationIds.length,
              })
            : pendingRemove?.kind === 'archived'
              ? pendingRemove.days === 0
                ? pendingRemove.projectName
                  ? t(
                      'All {{count}} archived conversations in "{{name}}" will be removed from the list.',
                      {
                        count: pendingRemove.conversationIds.length,
                        name: pendingRemove.projectName,
                      }
                    )
                  : t('All {{count}} archived conversations will be removed from the list.', {
                      count: pendingRemove.conversationIds.length,
                    })
                : pendingRemove.projectName
                  ? t(
                      '{{count}} conversations in "{{name}}" archived more than {{days}} days ago will be removed from the list.',
                      {
                        count: pendingRemove.conversationIds.length,
                        days: pendingRemove.days,
                        name: pendingRemove.projectName,
                      }
                    )
                  : t(
                      '{{count}} conversations archived more than {{days}} days ago will be removed from the list.',
                      { count: pendingRemove.conversationIds.length, days: pendingRemove.days }
                    )
              : pendingRemove?.kind === 'conversation' && pendingRemove.worktreeWarning
                ? t('This conversation and its isolated worktree will be removed: {{warning}}.', {
                    warning: pendingRemove.worktreeWarning,
                  })
                : t('This conversation will be removed from the list.')
        }
        confirmLabel={t('Remove')}
        onConfirm={() => {
          if (!pendingRemove) return;
          if (pendingRemove.kind === 'project') {
            for (const id of pendingRemove.conversationIds) removeConversation(id);
            void removeProject(pendingRemove.project.id);
          } else if (pendingRemove.kind === 'archived') {
            for (const id of pendingRemove.conversationIds) removeConversation(id);
          } else {
            removeConversation(pendingRemove.id);
          }
        }}
      />

      {/* 拖拽预览:侧栏 overflow-hidden 会裁切,portal 到 body */}
      {createPortal(
        <DragOverlay dropAnimation={null}>
          {/* 只认侧栏自己的 payload:同一 DndContext 里其它区域(如右侧面板 tab)的拖拽不在这里预览 */}
          {(dragPayload?.type === 'project' ||
            dragPayload?.type === 'chat' ||
            dragPayload?.type === 'workspace-file') && (
            <div className="flex w-56 items-center gap-2 rounded-lg border bg-background/95 px-3 py-1.5 text-sm shadow-md">
              {dragPayload.type === 'project' ? (
                <FolderGit2 className="h-4 w-4 shrink-0 text-muted-foreground" />
              ) : dragPayload.type === 'workspace-file' ? (
                <FileText className="h-4 w-4 shrink-0 text-muted-foreground" />
              ) : (
                <Pin className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              )}
              <span className="min-w-0 flex-1 truncate">
                {dragPayload.type === 'project'
                  ? dragPayload.name
                  : dragPayload.type === 'workspace-file'
                    ? dragPayload.name
                    : dragPayload.title.split('\n')[0].trim() || t('New conversation')}
              </span>
            </div>
          )}
        </DragOverlay>,
        document.body
      )}
    </motion.aside>
  );
}

/** 项目块的 sortable 包装:render prop 把 ref/transform/监听器交给现有 JSX,不重排结构 */
function SortableProject({
  project,
  children,
}: {
  project: Project;
  children: (drag: {
    setNodeRef: (node: HTMLElement | null) => void;
    style: React.CSSProperties;
    handleProps: Record<string, unknown>;
  }) => React.ReactNode;
}) {
  const { setNodeRef, transform, transition, listeners, isDragging } = useSortable({
    id: projectDragId(project.id),
    data: {
      type: 'project',
      projectId: project.id,
      path: project.path,
      name: project.name,
    } satisfies DragPayload,
  });
  return children({
    setNodeRef,
    style: {
      transform: CSS.Transform.toString(transform),
      transition,
      opacity: isDragging ? 0.4 : undefined,
    },
    handleProps: listeners ?? {},
  });
}

function ArchiveCleanupMenu({
  open,
  onOpenChange,
  idsForDays,
  onPick,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  idsForDays: (days: number) => string[];
  onPick: (days: number, ids: string[]) => void;
}) {
  const { t } = useI18n();
  return (
    <Menu open={open} onOpenChange={onOpenChange}>
      <MenuTrigger
        className={cn(
          'flex h-6 w-6 shrink-0 items-center justify-center rounded text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 hover:text-destructive',
          open && 'opacity-100'
        )}
        title={t('Clean up archived')}
        aria-label={t('Clean up archived')}
      >
        <Eraser className="h-3.5 w-3.5" />
      </MenuTrigger>
      <MenuPopup align="end" side="top" className="min-w-40">
        {ARCHIVE_PURGE_DAYS.map((days) => {
          const ids = idsForDays(days);
          return (
            <MenuItem
              key={days}
              variant="destructive"
              disabled={ids.length === 0}
              onClick={() => onPick(days, ids)}
            >
              {t('Older than {{days}} days', { days })}
            </MenuItem>
          );
        })}
        {(() => {
          const ids = idsForDays(0);
          return (
            <MenuItem
              variant="destructive"
              disabled={ids.length === 0}
              onClick={() => onPick(0, ids)}
            >
              {t('Delete all archived')}
            </MenuItem>
          );
        })()}
      </MenuPopup>
    </Menu>
  );
}

/** 置顶栏行:组内 sortable 拖拽重排,同时仍可拖入 Composer;独立 id 避免与项目组重复 */
function SortablePinnedChat({
  id,
  conversation,
  children,
}: {
  id: string;
  conversation: { title: string; sessionFile?: string; pinned?: boolean };
  children: React.ReactNode;
}) {
  const { setNodeRef, transform, transition, listeners, isDragging } = useSortable({
    id: pinnedChatDragId(id),
    data: {
      type: 'chat',
      conversationId: id,
      title: conversation.title,
      sessionFile: conversation.sessionFile,
      pinned: conversation.pinned === true,
    } satisfies DragPayload,
  });
  return (
    <div
      ref={setNodeRef}
      {...listeners}
      style={{
        transform: CSS.Transform.toString(transform),
        transition,
        opacity: isDragging ? 0.4 : undefined,
      }}
    >
      {children}
    </div>
  );
}

/** 会话行的拖拽源:拖入 Composer 成 mention / 拖到 Pinned 区置顶;原行拖动中降透明度 */
function DraggableChat({
  id,
  conversation,
  children,
}: {
  id: string;
  conversation: { title: string; sessionFile?: string; pinned?: boolean };
  children: React.ReactNode;
}) {
  const { setNodeRef, listeners, isDragging } = useDraggable({
    id: chatDragId(id),
    data: {
      type: 'chat',
      conversationId: id,
      title: conversation.title,
      sessionFile: conversation.sessionFile,
      pinned: conversation.pinned === true,
    } satisfies DragPayload,
  });
  return (
    <div ref={setNodeRef} {...listeners} style={{ opacity: isDragging ? 0.4 : undefined }}>
      {children}
    </div>
  );
}

/** Pinned 栏目落点:拖会话悬停时高亮 */
function PinnedDropZone({
  children,
  ...rest
}: {
  children: React.ReactNode;
} & Record<string, unknown>) {
  const { setNodeRef, isOver, active } = useDroppable({ id: PINNED_DROP_ID });
  const draggingChat = (active?.data.current as DragPayload | undefined)?.type === 'chat';
  return (
    <div
      ref={setNodeRef}
      className={cn('rounded-lg', isOver && draggingChat && 'bg-accent/40 ring-1 ring-ring')}
      {...rest}
    >
      {children}
    </div>
  );
}

interface ConversationRowProps {
  id: string;
  conversation: {
    title: string;
    status: string;
    spawning: boolean;
    pinned?: boolean;
    archived?: boolean;
    createdAt: number;
    projectId: string;
    messages: { timestamp?: number }[];
    forkedFromConversationId?: string;
  };
  active: boolean;
  locale: Parameters<typeof formatRelativeTime>[1];
  nowTick: number;
  /** 顶部 Pinned 栏目里用项目名做 hover 提示 */
  hoverTitle?: string;
  /** 已归档栏目里内联展示的项目名 */
  subtitle?: string;
  /** 隔离会话（有 worktree 绑定） */
  isolated?: boolean;
  /** 隔离会话的 worktree 状态（徽标：未提交/未合并） */
  worktreeStatus?: WorktreeStatus;
  switchHint?: string;
  onSelect: (id: string) => void;
  onTogglePin: (id: string) => void;
  onToggleArchive: (id: string) => void;
  onCleanupWorktree?: (id: string) => void;
  onMoveToWorktree?: (id: string) => void;
  onRemove: (id: string) => void;
}

/**
 * 侧栏会话行：Pinned/项目/Archived 三处共用。
 * 常规行 hover 只露置顶/归档，删除只在右键菜单里；
 * 归档行是删除前的暂存区，hover 露还原 + 删除。
 */
function ConversationRow({
  id,
  conversation,
  active,
  locale,
  nowTick,
  hoverTitle,
  subtitle,
  isolated,
  worktreeStatus,
  switchHint,
  onSelect,
  onTogglePin,
  onToggleArchive,
  onCleanupWorktree,
  onMoveToWorktree,
  onRemove,
}: ConversationRowProps) {
  const { t } = useI18n();
  const [renaming, setRenaming] = useState(false);
  const pinned = conversation.pinned === true;
  const archived = conversation.archived === true;
  const PinIcon = pinned ? PinOff : Pin;
  const displayTitle = conversation.title || t('New conversation');
  const sourceTitle = conversation.forkedFromConversationId
    ? useSessionsStore.getState().conversations[conversation.forkedFromConversationId]?.title
    : undefined;
  const row = (
    <div
      data-slot="conversation-row"
      data-pinned={pinned ? 'true' : 'false'}
      className={cn(
        // 会话行:标题对齐到项目名之下(chevron 槽 + 图标宽度),并用弱色与加粗的项目名区分
        'group flex cursor-pointer items-center gap-2 rounded-lg py-1.5 pr-2 pl-10 text-sm transition-colors',
        active
          ? 'bg-muted text-foreground'
          : 'text-muted-foreground hover:bg-muted/50 hover:text-foreground'
      )}
      onClick={() => {
        if (!renaming) onSelect(id);
      }}
      onDoubleClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        setRenaming(true);
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter' && !renaming) onSelect(id);
      }}
      role="button"
      tabIndex={0}
      title={hoverTitle}
    >
      <ConversationDot conversation={conversation} />
      {isolated && <WorktreeBadge status={worktreeStatus} />}
      {sourceTitle && (
        <span className="truncate text-[10px] text-muted-foreground/70">
          {t('Branched from {{title}}', { title: sourceTitle })}
        </span>
      )}
      {renaming ? (
        <ConversationTitleEdit
          title={displayTitle}
          onCommit={(title) => {
            useSessionsStore.getState().renameConversation(id, title);
            setRenaming(false);
          }}
          onCancel={() => setRenaming(false)}
        />
      ) : (
        <span className="min-w-0 flex-1 truncate">
          {displayTitle}
          {subtitle && <span className="ml-1.5 text-[10px] text-muted-foreground">{subtitle}</span>}
        </span>
      )}
      {!renaming &&
        (switchHint ? (
          <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground">
            {switchHint}
          </span>
        ) : (
          <>
            {pinned && !archived && (
              <Pin
                className="h-3 w-3 shrink-0 text-muted-foreground/70 group-hover:hidden"
                aria-hidden
              />
            )}
            <span className="shrink-0 text-[10px] text-muted-foreground group-hover:hidden">
              {formatRelativeTime(
                conversation.messages.at(-1)?.timestamp ?? conversation.createdAt,
                locale,
                nowTick
              )}
            </span>
            {!archived && (
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  onTogglePin(id);
                }}
                className="hidden shrink-0 rounded p-0.5 text-muted-foreground group-hover:block hover:text-foreground"
                title={pinned ? t('Unpin') : t('Pin')}
              >
                <PinIcon className="h-3.5 w-3.5" />
              </button>
            )}
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onToggleArchive(id);
              }}
              className="hidden shrink-0 rounded p-0.5 text-muted-foreground group-hover:block hover:text-foreground"
              title={archived ? t('Unarchive') : t('Archive')}
            >
              {archived ? (
                <ArchiveRestore className="h-3.5 w-3.5" />
              ) : (
                <Archive className="h-3.5 w-3.5" />
              )}
            </button>
            {archived && (
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  onRemove(id);
                }}
                className="hidden shrink-0 rounded p-0.5 text-muted-foreground group-hover:block hover:text-destructive"
                title={t('Delete')}
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            )}
          </>
        ))}
    </div>
  );
  return (
    <ContextMenu>
      <ContextMenuTrigger render={row as React.ReactElement<Record<string, unknown>>} />
      <ContextMenuPopup className="min-w-36">
        <ContextMenuItem onClick={() => setRenaming(true)}>
          <Pencil />
          {t('Rename')}
        </ContextMenuItem>
        {!archived && (
          <ContextMenuItem onClick={() => onTogglePin(id)}>
            <PinIcon />
            {pinned ? t('Unpin') : t('Pin')}
          </ContextMenuItem>
        )}
        <ContextMenuItem onClick={() => onToggleArchive(id)}>
          {archived ? <ArchiveRestore /> : <Archive />}
          {archived ? t('Unarchive') : t('Archive')}
        </ContextMenuItem>
        {!archived &&
          (isolated
            ? onCleanupWorktree && (
                <ContextMenuItem onClick={() => onCleanupWorktree(id)}>
                  <Eraser />
                  {t('Clean up worktree')}
                </ContextMenuItem>
              )
            : onMoveToWorktree &&
              useSettingsStore.getState().projects.find((p) => p.id === conversation.projectId)
                ?.kind !== 'ssh' && (
                <ContextMenuItem onClick={() => onMoveToWorktree(id)}>
                  <GitBranchPlus />
                  {t('Move to worktree')}
                </ContextMenuItem>
              ))}
        <ContextMenuSeparator />
        <ContextMenuItem variant="destructive" onClick={() => onRemove(id)}>
          <Trash2 />
          {t('Delete')}
        </ContextMenuItem>
      </ContextMenuPopup>
    </ContextMenu>
  );
}

/** 隔离会话徽标：分支图标，未提交改动琥珀色、未合并蓝色、干净灰色 */
function WorktreeBadge({ status }: { status?: WorktreeStatus }) {
  const { t } = useI18n();
  const dirty = status?.dirty === true;
  const unmerged = !dirty && (status?.ahead ?? 0) > 0;
  const title = dirty
    ? t('Isolated worktree · uncommitted changes')
    : unmerged
      ? t('Isolated worktree · {{n}} unmerged commits', { n: status?.ahead ?? 0 })
      : t('Isolated worktree');
  return (
    <span title={title} className="flex shrink-0 items-center">
      <GitBranch
        className={cn(
          'h-3 w-3',
          dirty ? 'text-amber-500' : unmerged ? 'text-blue-500' : 'text-muted-foreground/60'
        )}
      />
    </span>
  );
}

function ConversationDot({
  conversation,
}: {
  conversation: {
    status: string;
    spawning: boolean;
    unread?: boolean;
    pendingAsks?: { requestId: string }[];
  };
}) {
  const tone = conversationDotTone({
    status: conversation.status,
    spawning: conversation.spawning,
    unread: conversation.unread,
    pendingAskCount: conversation.pendingAsks?.length ?? 0,
  });
  return (
    <span
      className={cn(
        'h-1.5 w-1.5 shrink-0 rounded-full',
        tone === 'running' && 'animate-pulse bg-blue-500',
        tone === 'failed' && 'bg-destructive',
        tone === 'waiting' && 'animate-pulse bg-green-500',
        tone === 'unread' && 'bg-green-500',
        tone === 'idle' && 'bg-muted-foreground/30'
      )}
    />
  );
}
