import { projectDisplayName } from '@shared/projectName';
import { ProjectIcon } from '@/components/chat/ProjectIcon';
import type { CollapsedActiveProject } from './collapsedActiveProjects';

/** 48px 折叠栏里的头像，比项目行的 20px 更大，便于点按 */
export const COLLAPSED_ACTIVE_ICON_SIZE = 26;

export function collapsedActiveProjectLabel(name: string, title: string): string {
  return title ? `${name} · ${title}` : name;
}

/** 折叠栏中的进行中项目。没有时不渲染，不占高度。 */
export function CollapsedActiveProjectRail({
  entries,
  projects,
  onOpen,
}: {
  entries: readonly CollapsedActiveProject[];
  projects: readonly { id: string; name: string; path: string; alias?: string }[];
  onOpen: (entry: CollapsedActiveProject) => void;
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
        return (
          <button
            key={entry.projectId}
            type="button"
            data-enso="collapsed-active-project"
            data-project-id={entry.projectId}
            title={label}
            aria-label={label}
            onClick={() => onOpen(entry)}
            className="relative flex size-8 shrink-0 items-center justify-center rounded-lg hover:bg-foreground/5"
          >
            <ProjectIcon
              projectId={entry.projectId}
              displayName={name}
              size={COLLAPSED_ACTIVE_ICON_SIZE}
            />
            <span
              data-enso="collapsed-running-dot"
              className="pointer-events-none absolute top-0.5 right-0.5 size-2 rounded-full bg-emerald-500 ring-2 ring-background"
            />
          </button>
        );
      })}
    </div>
  );
}
