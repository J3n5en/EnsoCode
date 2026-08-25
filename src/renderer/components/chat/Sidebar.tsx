import type { Project } from '@shared/types';
import {
  ChevronDown,
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

const ICON_BUTTON_CLASS =
  'rounded-md p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground';

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

  // 相对时间每分钟自刷（“3 分钟前”不随时间僵住）
  const [nowTick, setNowTick] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNowTick(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);

  if (collapsed) {
    return (
      <aside className="flex w-10 shrink-0 flex-col items-center gap-1 border-r bg-muted/20 py-2">
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
    <aside className="flex shrink-0 flex-col bg-muted/20" style={{ width }}>
      <div className="flex items-center justify-between px-3 pt-3 pb-1.5">
        <span className="text-xs font-medium text-muted-foreground">{t('Projects')}</span>
        <button
          type="button"
          onClick={() => void handleAddProject()}
          className={ICON_BUTTON_CLASS}
          title={t('Add project')}
        >
          <FolderPlus className="h-3.5 w-3.5" />
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
        {projects.length === 0 && (
          <button
            type="button"
            onClick={() => void handleAddProject()}
            className="mt-1 w-full rounded-lg border border-dashed px-3 py-4 text-center text-xs text-muted-foreground transition-colors hover:border-ring hover:text-foreground"
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
            <div key={project.id} className="mt-1">
              <div className="group flex items-center gap-1 rounded-md px-1.5 py-1">
                <button
                  type="button"
                  onClick={() => toggleProject(project.id)}
                  className="flex min-w-0 flex-1 items-center gap-1 text-left"
                  title={project.path}
                >
                  <ChevronDown
                    className={cn(
                      'h-3 w-3 shrink-0 text-muted-foreground transition-transform',
                      folded && '-rotate-90'
                    )}
                  />
                  <span className="min-w-0 flex-1 truncate text-xs font-medium">
                    {project.name}
                  </span>
                </button>
                <button
                  type="button"
                  onClick={() => newConversation(project.id)}
                  className="rounded p-0.5 text-muted-foreground opacity-0 transition-opacity hover:text-foreground group-hover:opacity-100"
                  title={t('New conversation')}
                >
                  <MessageSquarePlus className="h-3.5 w-3.5" />
                </button>
                <button
                  type="button"
                  onClick={() => setImportProject(project)}
                  className="rounded p-0.5 text-muted-foreground opacity-0 transition-opacity hover:text-foreground group-hover:opacity-100"
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
                  className="rounded p-0.5 text-muted-foreground opacity-0 transition-opacity hover:text-destructive group-hover:opacity-100"
                  title={t('Remove project')}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
              {!folded &&
                projectConversations.map((id) => {
                  const conversation = conversations[id];
                  return (
                    <div
                      key={id}
                      className={cn(
                        'group flex cursor-pointer items-center gap-1.5 rounded-md py-1 pl-3 pr-1.5',
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
                      <span className="min-w-0 flex-1 truncate text-xs">
                        {conversation.title || t('New conversation')}
                      </span>
                      <span className="shrink-0 text-[10px] text-muted-foreground/70 group-hover:hidden">
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
                        className="hidden rounded p-0.5 text-muted-foreground hover:text-destructive group-hover:block"
                      >
                        <X className="h-3 w-3" />
                      </button>
                    </div>
                  );
                })}
            </div>
          );
        })}
      </div>

      <div className="flex items-center justify-between border-t px-2 py-1.5">
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
