import type { Project } from '@shared/types';
import {
  Archive,
  ArchiveRestore,
  ChevronRight,
  FolderGit2,
  FolderPlus,
  HardDriveDownload,
  MessageSquarePlus,
  PanelLeft,
  PanelLeftClose,
  Pin,
  PinOff,
  Settings,
  Trash2,
  X,
} from 'lucide-react';
import { useEffect, useState } from 'react';
import { AddProjectDialog } from '@/components/chat/AddProjectDialog';
import { ConfirmDialog } from '@/components/chat/ConfirmDialog';
import { ImportSessionDialog } from '@/components/chat/ImportSessionDialog';
import { useI18n } from '@/i18n';
import { formatRelativeTime } from '@/lib/time';
import { cn } from '@/lib/utils';
import { useSessionsStore } from '@/stores/sessions';
import {
  archivedConversationIds,
  pinnedConversationIds,
  projectConversationIds,
} from '@/stores/sessions/pinned';
import { useSettingsStore } from '@/stores/settings';

/** 每个项目默认露出的会话数,超过折叠进「展开」 */
const COLLAPSED_SESSION_LIMIT = 5;

const ICON_BUTTON_CLASS =
  'flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground';

interface SidebarProps {
  width?: number;
  collapsed: boolean;
  onToggleCollapse: () => void;
}

export function Sidebar({ width, collapsed, onToggleCollapse }: SidebarProps) {
  const { t, locale } = useI18n();
  const projects = useSettingsStore((state) => state.projects);
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

  const [addOpen, setAddOpen] = useState(false);
  const handleAddProject = (path: string) => {
    void addProject(path).then((project) => {
      if (project) void newConversation(project.id);
    });
  };

  const [importProject, setImportProject] = useState<Project | null>(null);
  // 待确认的删除动作(项目连带其对话 / 单个对话)
  const [pendingRemove, setPendingRemove] = useState<
    | { kind: 'project'; project: Project; conversationIds: string[] }
    | { kind: 'conversation'; id: string }
    | null
  >(null);
  // 展开显示全部会话的项目(会话级状态,重启回到折叠)
  const [expandedProjects, setExpandedProjects] = useState<Record<string, boolean>>({});

  const pinnedIds = pinnedConversationIds(order, conversations);
  const archivedIds = archivedConversationIds(order, conversations);
  // 底部「已归档」栏目的折叠态(缺省收起,重启回到收起)
  const [archivedOpen, setArchivedOpen] = useState(false);

  // 相对时间每分钟自刷（“3 分钟前”不随时间僵住）
  const [nowTick, setNowTick] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNowTick(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);

  if (collapsed) {
    return (
      <>
        <aside className="flex w-12 shrink-0 flex-col items-center gap-1 border-r bg-background py-2">
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
            onClick={() => window.electronAPI.window.openSettings()}
            className={ICON_BUTTON_CLASS}
            title={t('Settings')}
          >
            <Settings className="h-4 w-4" />
          </button>
        </aside>
        <AddProjectDialog open={addOpen} onOpenChange={setAddOpen} onAdd={handleAddProject} />
      </>
    );
  }

  return (
    <aside className="flex shrink-0 flex-col border-r bg-background" style={{ width }}>
      <div className="flex h-12 shrink-0 items-center justify-between border-b px-3">
        <span className="text-sm font-medium">{t('Projects')}</span>
        <button
          type="button"
          onClick={() => setAddOpen(true)}
          className={ICON_BUTTON_CLASS}
          title={t('Add project')}
        >
          <FolderPlus className="h-4 w-4" />
        </button>
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
        {pinnedIds.length > 0 && (
          <div data-slot="pinned-section">
            <div className="flex items-center gap-1.5 px-2 py-2">
              <Pin className="h-3.5 w-3.5 text-muted-foreground" />
              <span className="text-sm font-medium">{t('Pinned')}</span>
            </div>
            <div className="flex flex-col gap-y-0.5">
              {pinnedIds.map((id) => (
                <ConversationRow
                  key={id}
                  id={id}
                  conversation={conversations[id]}
                  active={activeId === id}
                  locale={locale}
                  nowTick={nowTick}
                  hoverTitle={projects.find((p) => p.id === conversations[id].projectId)?.name}
                  onSelect={selectConversation}
                  onTogglePin={togglePinConversation}
                  onToggleArchive={toggleArchiveConversation}
                  onRemove={(conversationId) =>
                    setPendingRemove({ kind: 'conversation', id: conversationId })
                  }
                />
              ))}
            </div>
          </div>
        )}
        {projects.map((project) => {
          const projectConversations = projectConversationIds(order, conversations, project.id);
          const folded = collapsedProjects[project.id] === true;
          return (
            <div key={project.id}>
              {/* 项目行：chevron 槽 + 仓库图标 + 名称 + 常驻操作（EnsoAI 尺寸） */}
              <div className="group flex w-full items-center gap-1 rounded-lg px-2 py-2 transition-colors hover:bg-accent/30">
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
                  <span className="min-w-0 flex-1 truncate text-sm font-medium">
                    {project.name}
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
              {!folded && (
                <div className="mt-0.5 flex flex-col gap-y-0.5">
                  {(expandedProjects[project.id]
                    ? projectConversations
                    : projectConversations.slice(0, COLLAPSED_SESSION_LIMIT)
                  ).map((id) => (
                    <ConversationRow
                      key={id}
                      id={id}
                      conversation={conversations[id]}
                      active={activeId === id}
                      locale={locale}
                      nowTick={nowTick}
                      onSelect={selectConversation}
                      onTogglePin={togglePinConversation}
                      onToggleArchive={toggleArchiveConversation}
                      onRemove={(conversationId) =>
                        setPendingRemove({ kind: 'conversation', id: conversationId })
                      }
                    />
                  ))}
                  {projectConversations.length > COLLAPSED_SESSION_LIMIT && (
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
                            n: projectConversations.length - COLLAPSED_SESSION_LIMIT,
                          })}
                    </button>
                  )}
                  {projectConversations.length === 0 && (
                    <p className="py-1.5 pl-9 text-xs text-muted-foreground">
                      {t('No conversations yet')}
                    </p>
                  )}
                </div>
              )}
            </div>
          );
        })}
        {archivedIds.length > 0 && (
          <div data-slot="archived-section" className="pt-1">
            <button
              type="button"
              onClick={() => setArchivedOpen((open) => !open)}
              className="flex w-full items-center gap-1 rounded-lg px-2 py-2 text-left transition-colors hover:bg-accent/30"
            >
              <span className="flex h-5 w-5 shrink-0 items-center justify-center">
                <ChevronRight
                  className={cn(
                    'h-3.5 w-3.5 text-muted-foreground transition-transform duration-200',
                    archivedOpen && 'rotate-90'
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
            {archivedOpen && (
              <div className="mt-0.5 flex flex-col gap-y-0.5">
                {archivedIds.map((id) => (
                  <ConversationRow
                    key={id}
                    id={id}
                    conversation={conversations[id]}
                    active={activeId === id}
                    locale={locale}
                    nowTick={nowTick}
                    hoverTitle={projects.find((p) => p.id === conversations[id].projectId)?.name}
                    onSelect={selectConversation}
                    onTogglePin={togglePinConversation}
                    onToggleArchive={toggleArchiveConversation}
                    onRemove={(conversationId) =>
                      setPendingRemove({ kind: 'conversation', id: conversationId })
                    }
                  />
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      <div className="flex shrink-0 items-center justify-between border-t p-2">
        <button
          type="button"
          onClick={onToggleCollapse}
          className={ICON_BUTTON_CLASS}
          title={t('Collapse sidebar')}
        >
          <PanelLeftClose className="h-4 w-4" />
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

      <AddProjectDialog open={addOpen} onOpenChange={setAddOpen} onAdd={handleAddProject} />
      <ImportSessionDialog project={importProject} onClose={() => setImportProject(null)} />
      <ConfirmDialog
        open={pendingRemove !== null}
        onOpenChange={(open) => {
          if (!open) setPendingRemove(null);
        }}
        title={pendingRemove?.kind === 'project' ? t('Remove project?') : t('Delete conversation?')}
        description={
          pendingRemove?.kind === 'project'
            ? t('"{{name}}" and its {{count}} conversations will be removed from the list.', {
                name: pendingRemove.project.name,
                count: pendingRemove.conversationIds.length,
              })
            : t('This conversation will be removed from the list.')
        }
        confirmLabel={t('Remove')}
        onConfirm={() => {
          if (!pendingRemove) return;
          if (pendingRemove.kind === 'project') {
            for (const id of pendingRemove.conversationIds) removeConversation(id);
            void removeProject(pendingRemove.project.id);
          } else {
            removeConversation(pendingRemove.id);
          }
        }}
      />
    </aside>
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
    messages: { timestamp?: number }[];
  };
  active: boolean;
  locale: Parameters<typeof formatRelativeTime>[1];
  nowTick: number;
  /** 顶部 Pinned 栏目里用项目名做 hover 提示 */
  hoverTitle?: string;
  onSelect: (id: string) => void;
  onTogglePin: (id: string) => void;
  onToggleArchive: (id: string) => void;
  onRemove: (id: string) => void;
}

/**
 * 侧栏会话行：Pinned/项目/Archived 三处共用。hover 时露出操作按钮：
 * 常规行 = 置顶 + 归档 + 删除；归档行 = 还原 + 删除（不可置顶）。
 */
function ConversationRow({
  id,
  conversation,
  active,
  locale,
  nowTick,
  hoverTitle,
  onSelect,
  onTogglePin,
  onToggleArchive,
  onRemove,
}: ConversationRowProps) {
  const { t } = useI18n();
  const pinned = conversation.pinned === true;
  const archived = conversation.archived === true;
  const PinIcon = pinned ? PinOff : Pin;
  return (
    <div
      data-slot="conversation-row"
      data-pinned={pinned ? 'true' : 'false'}
      className={cn(
        'group flex cursor-pointer items-center gap-2 rounded-lg py-1.5 pr-2 pl-4 text-sm transition-colors',
        active ? 'bg-muted' : 'hover:bg-muted/50'
      )}
      onClick={() => onSelect(id)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') onSelect(id);
      }}
      role="button"
      tabIndex={0}
      title={hoverTitle}
    >
      <ConversationDot conversation={conversation} />
      <span className="min-w-0 flex-1 truncate">{conversation.title || t('New conversation')}</span>
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
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          onRemove(id);
        }}
        className="hidden shrink-0 rounded p-0.5 text-muted-foreground group-hover:block hover:text-destructive"
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}

function ConversationDot({
  conversation,
}: {
  conversation: { status: string; spawning: boolean };
}) {
  const running = conversation.status === 'running' || conversation.spawning;
  return (
    <span
      className={cn(
        'h-1.5 w-1.5 shrink-0 rounded-full',
        running && 'animate-pulse bg-blue-500',
        conversation.status === 'failed' && 'bg-destructive',
        !running && conversation.status !== 'failed' && 'bg-muted-foreground/30'
      )}
    />
  );
}
