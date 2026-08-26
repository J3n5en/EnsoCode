import type { Project } from '@shared/types';
import {
  ChevronRight,
  FolderGit2,
  FolderPlus,
  HardDriveDownload,
  MessageSquarePlus,
  PanelLeft,
  PanelLeftClose,
  Settings,
  Trash2,
  X,
} from 'lucide-react';
import { useEffect, useState } from 'react';
import { ImportSessionDialog } from '@/components/chat/ImportSessionDialog';
import { useI18n } from '@/i18n';
import { formatRelativeTime } from '@/lib/time';
import { cn } from '@/lib/utils';
import { useSessionsStore } from '@/stores/sessions';
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

  const handleAddProject = async () => {
    const path = await window.electronAPI.dialog.selectDirectory();
    if (!path) return;
    const project = addProject(path);
    newConversation(project.id);
  };

  const [importProject, setImportProject] = useState<Project | null>(null);
  // 展开显示全部会话的项目(会话级状态,重启回到折叠)
  const [expandedProjects, setExpandedProjects] = useState<Record<string, boolean>>({});

  // 相对时间每分钟自刷（“3 分钟前”不随时间僵住）
  const [nowTick, setNowTick] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNowTick(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);

  if (collapsed) {
    return (
      <aside className="flex w-12 shrink-0 flex-col items-center gap-1 border-r bg-background py-2">
        <button
          type="button"
          onClick={() => void handleAddProject()}
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
    );
  }

  return (
    <aside className="flex shrink-0 flex-col border-r bg-background" style={{ width }}>
      <div className="flex h-12 shrink-0 items-center justify-between border-b px-3">
        <span className="text-sm font-medium">{t('Projects')}</span>
        <button
          type="button"
          onClick={() => void handleAddProject()}
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
            onClick={() => void handleAddProject()}
            className="w-full rounded-lg border border-dashed px-3 py-6 text-center text-sm text-muted-foreground transition-colors hover:border-ring hover:text-foreground"
          >
            {t('Add a project to start')}
          </button>
        )}
        {projects.map((project) => {
          const projectConversations = order.filter(
            (id) => conversations[id]?.projectId === project.id
          );
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
                  onClick={() => newConversation(project.id)}
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
                  onClick={() => {
                    for (const id of projectConversations) removeConversation(id);
                    removeProject(project.id);
                  }}
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
                  ).map((id) => {
                    const conversation = conversations[id];
                    return (
                      <div
                        key={id}
                        className={cn(
                          'group flex cursor-pointer items-center gap-2 rounded-lg py-1.5 pr-2 pl-4 text-sm transition-colors',
                          activeId === id ? 'bg-muted' : 'hover:bg-muted/50'
                        )}
                        onClick={() => selectConversation(id)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') selectConversation(id);
                        }}
                        role="button"
                        tabIndex={0}
                      >
                        <ConversationDot conversation={conversation} />
                        <span className="min-w-0 flex-1 truncate">
                          {conversation.title || t('New conversation')}
                        </span>
                        <span className="shrink-0 text-[10px] text-muted-foreground group-hover:hidden">
                          {formatRelativeTime(
                            conversation.messages.at(-1)?.timestamp ?? conversation.createdAt,
                            locale,
                            nowTick
                          )}
                        </span>
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            removeConversation(id);
                          }}
                          className="hidden shrink-0 rounded p-0.5 text-muted-foreground group-hover:block hover:text-destructive"
                        >
                          <X className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    );
                  })}
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

      <ImportSessionDialog project={importProject} onClose={() => setImportProject(null)} />
    </aside>
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
