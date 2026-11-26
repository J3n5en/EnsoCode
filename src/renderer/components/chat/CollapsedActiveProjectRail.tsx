import { projectDisplayName } from '@shared/projectName';
import { ConversationStatusIndicator } from '@/components/chat/ConversationStatusIndicator';
import { ProjectIcon } from '@/components/chat/ProjectIcon';
import { PreviewCard, PreviewCardPopup, PreviewCardTrigger } from '@/components/ui/preview-card';
import { useI18n } from '@/i18n';
import type { CollapsedActiveProject, CollapsedProjectSession } from './collapsedActiveProjects';

/** 48px 折叠栏里的头像，比项目行的 20px 更大，便于点按 */
export const COLLAPSED_ACTIVE_ICON_SIZE = 26;

export function collapsedActiveProjectLabel(name: string, title: string): string {
  return title ? `${name} · ${title}` : name;
}

function HoverSessions({
  sessions,
  onOpenSession,
}: {
  sessions: readonly CollapsedProjectSession[];
  onOpenSession: (session: CollapsedProjectSession) => void;
}) {
  const { t } = useI18n();
  return (
    <div className="max-h-64 overflow-y-auto p-1" data-enso="collapsed-active-sessions">
      {sessions.map((session) => (
        <button
          key={session.conversationId}
          type="button"
          data-enso="collapsed-active-session"
          data-conversation-id={session.conversationId}
          onClick={() => onOpenSession(session)}
          className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-foreground/5"
        >
          {session.tone !== 'idle' && <ConversationStatusIndicator tone={session.tone} size="sm" />}
          {session.tone === 'idle' && <span className="size-2 shrink-0" />}
          <span className="min-w-0 flex-1 truncate">{session.title || t('New conversation')}</span>
        </button>
      ))}
    </div>
  );
}

/** 折叠栏中的进行中项目。没有时不渲染，不占高度。 */
export function CollapsedActiveProjectRail({
  entries,
  projects,
  sessionsByProject,
  onOpen,
  onOpenSession,
}: {
  entries: readonly CollapsedActiveProject[];
  projects: readonly { id: string; name: string; path: string; alias?: string }[];
  /** 各项目全部未归档会话（含 tone），由调用方按 store 数据算好 */
  sessionsByProject: Readonly<Record<string, readonly CollapsedProjectSession[]>>;
  onOpen: (entry: CollapsedActiveProject) => void;
  onOpenSession: (session: CollapsedProjectSession) => void;
}) {
  if (entries.length === 0) return null;
  return (
    <div
      data-enso="collapsed-active-projects"
      className="flex min-h-0 w-full shrink flex-col items-center gap-1 overflow-y-auto [scrollbar-width:none]"
    >
      {entries.map((entry) => {
        const project = projects.find((item) => item.id === entry.projectId);
        const name = project ? projectDisplayName(project) : entry.projectId;
        const label = collapsedActiveProjectLabel(name, entry.title);
        const sessions = sessionsByProject[entry.projectId] ?? [];
        const activeCount = sessions.length;
        return (
          <PreviewCard key={entry.projectId}>
            <PreviewCardTrigger
              delay={250}
              closeDelay={200}
              render={
                <button
                  type="button"
                  data-enso="collapsed-active-project"
                  data-project-id={entry.projectId}
                  title={label}
                  aria-label={label}
                  onClick={() => onOpen(entry)}
                  className="relative flex size-8 shrink-0 items-center justify-center rounded-lg hover:bg-foreground/5"
                />
              }
            >
              <ProjectIcon
                projectId={entry.projectId}
                displayName={name}
                size={COLLAPSED_ACTIVE_ICON_SIZE}
              />
              {activeCount > 1 ? (
                <span
                  data-enso="collapsed-session-badge"
                  className="pointer-events-none absolute -top-0.5 -right-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-emerald-500 px-0.5 font-semibold text-[10px] text-white leading-none tabular-nums ring-2 ring-background"
                >
                  {activeCount > 9 ? '9+' : activeCount}
                </span>
              ) : (
                <span
                  data-enso="collapsed-running-dot"
                  className="pointer-events-none absolute top-0.5 right-0.5 size-2 rounded-full bg-emerald-500 ring-2 ring-background"
                />
              )}
            </PreviewCardTrigger>
            {activeCount > 1 && (
              <PreviewCardPopup
                align="start"
                side="right"
                sideOffset={8}
                className="w-[240px] flex-col p-0 text-[12.5px]"
              >
                <HoverSessions sessions={sessions} onOpenSession={onOpenSession} />
              </PreviewCardPopup>
            )}
          </PreviewCard>
        );
      })}
    </div>
  );
}
