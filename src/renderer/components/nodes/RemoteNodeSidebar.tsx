import {
  type CatalogEntry,
  type ProjectEntry,
  type ProjectGroupEntry,
  pairProjectDisplayName,
} from '@enso/pair';
import { orderPinned, orderProjectSessions, sortByActivity } from '@shared/pair/drawerOrder';
import {
  ALL_GROUP_ID,
  filterProjectsByGroup,
  sectionsForAllView,
  UNGROUPED_GROUP_ID,
} from '@shared/projectGroups';
import type { RemoteNodeStatus } from '@shared/types/nodes';
import { Archive, ChevronDown, ChevronRight, Pin, Search, SquarePen } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { Input } from '@/components/ui/input';
import { useI18n } from '@/i18n';
import { formatRelativeTime } from '@/lib/time';
import { cn } from '@/lib/utils';
import { NodeSwitcher } from './NodeSwitcher';

interface RemoteNodeSidebarProps {
  width: number | undefined;
  node: RemoteNodeStatus;
  catalog: CatalogEntry[];
  pinnedOrder: string[];
  projects: ProjectEntry[];
  groups?: ProjectGroupEntry[];
  activeId: string | null;
  canCreate: boolean;
  onSelect: (id: string) => void;
  onNewConversation: () => void;
}

const ICON_BUTTON_CLASS =
  'flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground';

/**
 * 远程节点侧栏：对方目录按项目分组，置顶/归档分栏（与本机侧栏、手机抽屉同语义）。
 * 只做选择与新建：置顶/归档/重命名/删除协议不支持，不露入口。
 */
export function RemoteNodeSidebar({
  width,
  node,
  catalog,
  pinnedOrder,
  projects,
  groups = [],
  activeId,
  canCreate,
  onSelect,
  onNewConversation,
}: RemoteNodeSidebarProps) {
  const { t, locale } = useI18n();
  const [selectedGroupId, setSelectedGroupId] = useState(ALL_GROUP_ID);
  const [query, setQuery] = useState('');
  const [folded, setFolded] = useState<Record<string, boolean>>({});
  const [archivedOpen, setArchivedOpen] = useState(false);
  const [nowTick, setNowTick] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNowTick(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);

  const resolvedGroupId =
    selectedGroupId === ALL_GROUP_ID ||
    selectedGroupId === UNGROUPED_GROUP_ID ||
    groups.some((group) => group.id === selectedGroupId)
      ? selectedGroupId
      : ALL_GROUP_ID;
  const archivedIds = projects.filter((project) => project.archived).map((project) => project.id);
  const slicedProjects = filterProjectsByGroup(projects, groups, archivedIds, resolvedGroupId);
  const slicedIdSet = new Set(slicedProjects.map((project) => project.id));
  const q = query.trim().toLowerCase();
  const topLevel = useMemo(
    () => catalog.filter((c) => !c.parentId && (!q || c.title.toLowerCase().includes(q))),
    [catalog, q]
  );
  const pinned = orderPinned(
    topLevel.filter(
      (c) => c.pinned && !c.archived && (!c.projectId || slicedIdSet.has(c.projectId))
    ),
    pinnedOrder
  );
  const archived = sortByActivity(
    topLevel.filter((c) => {
      if (!c.archived) return false;
      if (resolvedGroupId === ALL_GROUP_ID) return true;
      return Boolean(c.projectId && slicedIdSet.has(c.projectId));
    })
  );
  const active = topLevel.filter((c) => !c.archived);
  const known = new Set(projects.map((p) => p.id));
  const orphans = orderProjectSessions(active.filter((c) => !known.has(c.projectId)));

  const row = (c: CatalogEntry, subtitle?: string) => (
    <button
      key={c.id}
      type="button"
      onClick={() => onSelect(c.id)}
      className={cn(
        'group flex w-full items-center gap-2 rounded-lg py-1.5 pr-2 pl-4 text-left text-sm transition-colors',
        activeId === c.id ? 'bg-muted' : 'hover:bg-muted/50'
      )}
    >
      <span
        className={cn(
          'h-2 w-2 shrink-0 rounded-full',
          c.status === 'running' && 'animate-pulse bg-blue-500',
          c.status === 'failed' && 'bg-destructive',
          c.status === 'idle' && (c.unread ? 'bg-emerald-500' : 'bg-muted-foreground/30')
        )}
      />
      <span className="min-w-0 flex-1 truncate">
        {c.title || t('New conversation')}
        {subtitle && <span className="ml-1.5 text-[10px] text-muted-foreground">{subtitle}</span>}
      </span>
      {c.updatedAt !== undefined && (
        <span className="shrink-0 text-[10px] text-muted-foreground">
          {formatRelativeTime(c.updatedAt, locale, nowTick)}
        </span>
      )}
    </button>
  );

  return (
    <aside
      className="flex shrink-0 flex-col overflow-hidden border-r bg-background"
      style={{ width }}
    >
      <div className="flex h-12 shrink-0 items-center justify-between border-b pr-3 pl-1.5">
        <NodeSwitcher />
        <button
          type="button"
          onClick={onNewConversation}
          disabled={!canCreate}
          className={cn(ICON_BUTTON_CLASS, !canCreate && 'opacity-40')}
          title={t('New remote conversation')}
        >
          <SquarePen className="h-4 w-4" />
        </button>
      </div>
      <div className="shrink-0 border-b px-2 py-2">
        <div className="relative">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 z-10 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t('Search conversations...')}
            className="h-8 text-xs [&_input]:pl-8"
          />
        </div>
      </div>
      {groups.length > 0 && (
        <div className="shrink-0 border-b px-2 py-2">
          <select
            className="h-8 w-full rounded-md border bg-background px-2 text-xs"
            value={resolvedGroupId}
            onChange={(event) => setSelectedGroupId(event.target.value)}
          >
            <option value={ALL_GROUP_ID}>{t('All')}</option>
            {groups
              .slice()
              .sort((a, b) => a.order - b.order)
              .map((group) => (
                <option key={group.id} value={group.id}>
                  {group.name}
                </option>
              ))}
            <option value={UNGROUPED_GROUP_ID}>{t('Ungrouped')}</option>
          </select>
        </div>
      )}

      <div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-2">
        {!node.hostOnline && catalog.length === 0 && (
          <p className="rounded-lg border border-dashed px-3 py-6 text-center text-muted-foreground text-sm">
            {node.connected ? t('Remote desktop is offline') : t('Connecting…')}
          </p>
        )}
        {node.hostOnline && projects.length === 0 && (
          <p className="rounded-lg border border-dashed px-3 py-6 text-center text-muted-foreground text-sm">
            {t('The remote desktop has no projects yet')}
          </p>
        )}

        {pinned.length > 0 && (
          <div>
            <div className="flex items-center gap-1.5 px-2 py-2">
              <Pin className="h-3.5 w-3.5 text-muted-foreground" />
              <span className="font-medium text-sm">{t('Pinned')}</span>
            </div>
            <div className="flex flex-col gap-y-0.5">
              {pinned.map((c) => row(c, c.projectName))}
            </div>
          </div>
        )}

        {(resolvedGroupId === ALL_GROUP_ID && groups.length > 0
          ? sectionsForAllView(projects, groups, archivedIds).flatMap((section) => {
              const foldedSection = folded[`g:${section.groupId}`] === true;
              return [
                { kind: 'header' as const, section, foldedSection },
                ...(foldedSection
                  ? []
                  : section.projects.map((project) => ({ kind: 'project' as const, project }))),
              ];
            })
          : slicedProjects.map((project) => ({ kind: 'project' as const, project }))
        ).map((item) => {
          if (item.kind === 'header') {
            return (
              <button
                key={`hdr-${item.section.groupId}`}
                type="button"
                onClick={() =>
                  setFolded((prev) => ({
                    ...prev,
                    [`g:${item.section.groupId}`]: !prev[`g:${item.section.groupId}`],
                  }))
                }
                className="flex h-7 w-full items-center gap-1 rounded-md px-2 text-left text-xs font-medium text-muted-foreground"
              >
                <ChevronRight
                  className={cn(
                    'h-3.5 w-3.5 shrink-0 transition-transform duration-150',
                    !item.foldedSection && 'rotate-90'
                  )}
                />
                {item.section.group?.emoji && (
                  <span className="shrink-0 text-sm">{item.section.group.emoji}</span>
                )}
                {item.section.group?.color && (
                  <span
                    className="h-2 w-2 shrink-0 rounded-full"
                    style={{ backgroundColor: item.section.group.color }}
                  />
                )}
                <span className="min-w-0 flex-1 truncate">
                  {item.section.group?.name ?? t('Ungrouped')}
                </span>
                <span className="shrink-0 text-[10px] text-muted-foreground/70">
                  {item.section.projects.length}
                </span>
              </button>
            );
          }
          const { project } = item;
          const sessions = orderProjectSessions(
            active.filter((c) => c.projectId === project.id && !c.pinned)
          );
          if (q && sessions.length === 0) return null;
          const isFolded = folded[project.id] === true;
          return (
            <div key={project.id}>
              <button
                type="button"
                onClick={() => setFolded((prev) => ({ ...prev, [project.id]: !isFolded }))}
                className="flex w-full items-center gap-1.5 rounded-lg px-2 py-2 text-left transition-colors hover:bg-muted/50"
              >
                {isFolded ? (
                  <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                ) : (
                  <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                )}
                <span className="min-w-0 flex-1 truncate font-medium text-sm">
                  {pairProjectDisplayName(project)}
                </span>
                {project.sshHost && (
                  <span className="shrink-0 rounded bg-muted px-1 font-mono text-[10px] text-muted-foreground">
                    ssh
                  </span>
                )}
              </button>
              {!isFolded && (
                <div className="flex flex-col gap-y-0.5">
                  {sessions.length === 0 && (
                    <p className="px-4 py-1.5 text-muted-foreground text-xs">
                      {t('No conversations')}
                    </p>
                  )}
                  {sessions.map((c) => row(c))}
                </div>
              )}
            </div>
          );
        })}

        {orphans.length > 0 && (
          <div>
            <div className="px-2 py-2 font-medium text-sm">{t('Other')}</div>
            <div className="flex flex-col gap-y-0.5">{orphans.map((c) => row(c))}</div>
          </div>
        )}

        {archived.length > 0 && (
          <div>
            <button
              type="button"
              onClick={() => setArchivedOpen((v) => !v)}
              className="flex w-full items-center gap-1.5 rounded-lg px-2 py-2 text-left transition-colors hover:bg-muted/50"
            >
              <Archive className="h-3.5 w-3.5 text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate font-medium text-sm">{t('Archived')}</span>
              <span className="text-[10px] text-muted-foreground">{archived.length}</span>
            </button>
            {archivedOpen && (
              <div className="flex flex-col gap-y-0.5">
                {archived.map((c) => row(c, c.projectName))}
              </div>
            )}
          </div>
        )}
      </div>
    </aside>
  );
}
