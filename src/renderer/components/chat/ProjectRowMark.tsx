import { ChevronRight } from 'lucide-react';
import { ProjectIcon } from '@/components/chat/ProjectIcon';
import { cn } from '@/lib/utils';

/** 与项目名行高对齐：h-8 行里上下各留 6px */
export const PROJECT_ROW_ICON_SIZE = 20;

/** 行首只留头像。折叠箭头悬停时盖住头像，点击仍由整行处理。 */
export function ProjectRowMark({
  projectId,
  displayName,
  folded,
}: {
  projectId: string;
  displayName: string;
  folded: boolean;
}) {
  return (
    <span className="relative flex size-5 shrink-0 items-center justify-center">
      <ProjectIcon
        projectId={projectId}
        displayName={displayName}
        size={PROJECT_ROW_ICON_SIZE}
        className="transition-opacity group-hover:opacity-0 motion-reduce:transition-none"
      />
      <span
        data-enso="tree-chevron"
        data-expanded={!folded || undefined}
        className="pointer-events-none absolute inset-0 hidden items-center justify-center text-subtle-foreground group-hover:flex"
      >
        <ChevronRight
          className={cn('size-3.5 transition-transform duration-150', !folded && 'rotate-90')}
        />
      </span>
    </span>
  );
}
