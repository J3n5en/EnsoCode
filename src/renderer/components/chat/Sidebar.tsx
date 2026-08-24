import { FolderPlus, MessageSquarePlus, Trash2, X } from 'lucide-react';
import { useI18n } from '@/i18n';
import { cn } from '@/lib/utils';
import { useSessionsStore } from '@/stores/sessions';
import { useSettingsStore } from '@/stores/settings';

export function Sidebar() {
  const { t } = useI18n();
  const projects = useSettingsStore((state) => state.projects);
  const addProject = useSettingsStore((state) => state.addProject);
  const removeProject = useSettingsStore((state) => state.removeProject);
  const conversations = useSessionsStore((state) => state.conversations);
  const order = useSessionsStore((state) => state.order);
  const activeId = useSessionsStore((state) => state.activeId);
  const newConversation = useSessionsStore((state) => state.newConversation);
  const selectConversation = useSessionsStore((state) => state.selectConversation);
  const removeConversation = useSessionsStore((state) => state.removeConversation);

  const handleAddProject = async () => {
    const path = await window.electronAPI.dialog.selectDirectory();
    if (!path) return;
    const project = addProject(path);
    newConversation(project.id);
  };

  return (
    <aside className="flex w-60 shrink-0 flex-col border-r bg-muted/20">
      <div className="flex items-center justify-between px-3 pt-3 pb-1.5">
        <span className="text-xs font-medium text-muted-foreground">{t('Projects')}</span>
        <button
          type="button"
          onClick={() => void handleAddProject()}
          className="rounded-md p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
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
          return (
            <div key={project.id} className="mt-1">
              <div className="group flex items-center gap-1 rounded-md px-1.5 py-1">
                <span className="min-w-0 flex-1 truncate text-xs font-medium" title={project.path}>
                  {project.name}
                </span>
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
              {projectConversations.map((id) => {
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
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        removeConversation(id);
                      }}
                      className="rounded p-0.5 text-muted-foreground opacity-0 transition-opacity hover:text-destructive group-hover:opacity-100"
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
