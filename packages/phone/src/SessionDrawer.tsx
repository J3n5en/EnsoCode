import type { CatalogEntry, ProjectEntry } from '@enso/pair';
import { ChevronRight, FolderGit2, MessageSquarePlus, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { formatRelativeTime } from '@/lib/time';
import { cn } from '@/lib/utils';

/**
 * 手机侧边栏：复刻桌面 Sidebar 的项目分组结构（chevron / 仓库图标 / 状态点 /
 * 相对时间 / 折叠更多），改为抽屉式呈现。桌面版的加项目、导入、删除属于
 * 宿主能力，手机端不提供。
 */

const COLLAPSED_SESSION_LIMIT = 5;

interface Props {
  open: boolean;
  projects: ProjectEntry[];
  catalog: CatalogEntry[];
  activeId: string | null;
  canCreate: boolean;
  onClose(): void;
  onSelect(sessionId: string): void;
  onNewConversation(projectId: string): void;
}

export function SessionDrawer({
  open,
  projects,
  catalog,
  activeId,
  canCreate,
  onClose,
  onSelect,
  onNewConversation,
}: Props) {
  const [foldedProjects, setFoldedProjects] = useState<Record<string, boolean>>({});
  const [expandedProjects, setExpandedProjects] = useState<Record<string, boolean>>({});

  // 相对时间每分钟自刷（与桌面一致，避免「3 分钟前」僵住）
  const [nowTick, setNowTick] = useState(() => Date.now());
  useEffect(() => {
    if (!open) return;
    const timer = setInterval(() => setNowTick(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, [open]);

  // 没有项目归属的会话（项目已删等）单独归到「其他」
  const known = new Set(projects.map((p) => p.id));
  const orphans = catalog.filter((c) => !c.parentId && !known.has(c.projectId));

  return (
    <>
      <button
        type="button"
        aria-label="关闭侧栏"
        onClick={onClose}
        className={cn(
          'fixed inset-0 z-40 bg-black/40 transition-opacity duration-200',
          open ? 'opacity-100' : 'pointer-events-none opacity-0'
        )}
      />
      <aside
        className={cn(
          'fixed inset-y-0 left-0 z-50 flex w-[82vw] max-w-xs flex-col border-r bg-background transition-transform duration-200',
          open ? 'translate-x-0' : '-translate-x-full'
        )}
      >
        <div className="flex h-12 shrink-0 items-center justify-between border-b px-3 pt-safe">
          <span className="font-medium text-sm">项目</span>
          <button
            type="button"
            onClick={onClose}
            className="rounded p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="min-h-0 flex-1 space-y-1 overflow-y-auto p-2 pb-safe">
          {projects.length === 0 && (
            <p className="rounded-lg border border-dashed px-3 py-6 text-center text-muted-foreground text-sm">
              桌面端还没有项目
            </p>
          )}

          {projects.map((project) => (
            <ProjectGroup
              key={project.id}
              name={project.name}
              sessions={catalog.filter((c) => !c.parentId && c.projectId === project.id)}
              folded={foldedProjects[project.id] === true}
              expanded={expandedProjects[project.id] === true}
              activeId={activeId}
              nowTick={nowTick}
              canCreate={canCreate}
              onToggleFold={() =>
                setFoldedProjects((prev) => ({ ...prev, [project.id]: !prev[project.id] }))
              }
              onToggleExpand={() =>
                setExpandedProjects((prev) => ({ ...prev, [project.id]: !prev[project.id] }))
              }
              onSelect={onSelect}
              onNew={() => onNewConversation(project.id)}
            />
          ))}

          {orphans.length > 0 && (
            <ProjectGroup
              name="其他"
              sessions={orphans}
              folded={foldedProjects.__orphan === true}
              expanded={expandedProjects.__orphan === true}
              activeId={activeId}
              nowTick={nowTick}
              canCreate={false}
              onToggleFold={() =>
                setFoldedProjects((prev) => ({ ...prev, __orphan: !prev.__orphan }))
              }
              onToggleExpand={() =>
                setExpandedProjects((prev) => ({ ...prev, __orphan: !prev.__orphan }))
              }
              onSelect={onSelect}
            />
          )}
        </div>
      </aside>
    </>
  );
}

function ProjectGroup({
  name,
  sessions,
  folded,
  expanded,
  activeId,
  nowTick,
  canCreate,
  onToggleFold,
  onToggleExpand,
  onSelect,
  onNew,
}: {
  name: string;
  sessions: CatalogEntry[];
  folded: boolean;
  expanded: boolean;
  activeId: string | null;
  nowTick: number;
  canCreate: boolean;
  onToggleFold(): void;
  onToggleExpand(): void;
  onSelect(id: string): void;
  onNew?(): void;
}) {
  const shown = expanded ? sessions : sessions.slice(0, COLLAPSED_SESSION_LIMIT);
  return (
    <div>
      <div className="flex w-full items-center gap-1 rounded-lg px-2 py-2 transition-colors hover:bg-accent/30">
        <button
          type="button"
          onClick={onToggleFold}
          className="flex min-w-0 flex-1 items-center gap-1 text-left"
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
          <span className="min-w-0 flex-1 truncate font-medium text-sm">{name}</span>
          <span className="shrink-0 text-[10px] text-muted-foreground">{sessions.length}</span>
        </button>
        {canCreate && onNew && (
          <button
            type="button"
            onClick={onNew}
            className="shrink-0 rounded p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            <MessageSquarePlus className="h-3.5 w-3.5" />
          </button>
        )}
      </div>

      {!folded && (
        <div className="mt-0.5 flex flex-col gap-y-0.5">
          {shown.map((session) => (
            <button
              key={session.id}
              type="button"
              onClick={() => onSelect(session.id)}
              className={cn(
                'flex items-center gap-2 rounded-lg py-2 pr-2 pl-4 text-left text-sm transition-colors',
                activeId === session.id ? 'bg-muted' : 'hover:bg-muted/50'
              )}
            >
              <StatusDot status={session.status} />
              <span className="min-w-0 flex-1 truncate">{session.title || '新对话'}</span>
              {session.updatedAt && (
                <span className="shrink-0 text-[10px] text-muted-foreground">
                  {formatRelativeTime(session.updatedAt, 'zh', nowTick)}
                </span>
              )}
            </button>
          ))}
          {sessions.length > COLLAPSED_SESSION_LIMIT && (
            <button
              type="button"
              onClick={onToggleExpand}
              className="rounded-lg py-1 text-center text-muted-foreground text-xs transition-colors hover:bg-muted/50 hover:text-foreground"
            >
              {expanded ? '收起' : `展开其余 ${sessions.length - COLLAPSED_SESSION_LIMIT} 条`}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/** 与桌面 ConversationDot 同款 */
function StatusDot({ status }: { status: string }) {
  const running = status === 'running';
  return (
    <span
      className={cn(
        'h-1.5 w-1.5 shrink-0 rounded-full',
        running && 'animate-pulse bg-blue-500',
        status === 'failed' && 'bg-destructive',
        !running && status !== 'failed' && 'bg-muted-foreground/30'
      )}
    />
  );
}
