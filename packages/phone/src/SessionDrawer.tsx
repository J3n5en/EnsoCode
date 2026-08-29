import type { CatalogEntry, ProjectEntry } from '@enso/pair';
import { Bot, ChevronRight, FolderGit2, MessageSquarePlus, Palette, Unplug, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { formatRelativeTime } from '@/lib/time';
import { cn } from '@/lib/utils';
import {
  getThemePreference,
  setThemePreference,
  subscribeTheme,
  type ThemePreference,
} from './theme';

/**
 * 手机侧边栏：复刻桌面 Sidebar 的项目分组结构（chevron / 仓库图标 / 状态点 /
 * 相对时间 / 折叠更多），改为抽屉式呈现。桌面版的加项目、导入、删除属于
 * 宿主能力，手机端不提供。
 */

const COLLAPSED_SESSION_LIMIT = 5;

/** auto = 跟随桌面下发；其余为本地覆盖 */
const THEME_OPTIONS: { value: ThemePreference; label: string }[] = [
  { value: 'auto', label: '跟随桌面' },
  { value: 'light', label: '浅' },
  { value: 'dark', label: '深' },
];

interface Props {
  open: boolean;
  projects: ProjectEntry[];
  catalog: CatalogEntry[];
  activeId: string | null;
  canCreate: boolean;
  /** 已配对的桌面标识（配对时记录的设备名） */
  deviceName: string;
  connected: boolean;
  connectionLabel: string;
  onClose(): void;
  onSelect(sessionId: string): void;
  onNewConversation(projectId: string): void;
  /** 解绑并回到配对页 */
  onUnpair(): void;
}

export function SessionDrawer({
  open,
  projects,
  catalog,
  activeId,
  canCreate,
  deviceName,
  connected,
  connectionLabel,
  onClose,
  onSelect,
  onNewConversation,
  onUnpair,
}: Props) {
  const [foldedProjects, setFoldedProjects] = useState<Record<string, boolean>>({});
  const [expandedProjects, setExpandedProjects] = useState<Record<string, boolean>>({});
  const [confirmUnpair, setConfirmUnpair] = useState(false);
  const [themePref, setThemePref] = useState<ThemePreference>(getThemePreference);

  // 主题可能由桌面下发触发变化，订阅后同步按钮高亮
  useEffect(() => subscribeTheme(() => setThemePref(getThemePreference())), []);

  // 抽屉关闭时收起确认态，避免下次打开还停在确认框
  useEffect(() => {
    if (!open) setConfirmUnpair(false);
  }, [open]);

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

  // coworker 等子会话按父 id 归组，嵌套展示在父会话下（可点进查看完整输出）
  const childrenByParent = new Map<string, CatalogEntry[]>();
  for (const entry of catalog) {
    if (!entry.parentId) continue;
    const list = childrenByParent.get(entry.parentId) ?? [];
    list.push(entry);
    childrenByParent.set(entry.parentId, list);
  }

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

        <div className="min-h-0 flex-1 space-y-1 overflow-y-auto p-2">
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
              childrenByParent={childrenByParent}
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
              childrenByParent={childrenByParent}
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

        <div className="shrink-0 space-y-1 border-t p-2 pb-safe">
          {!confirmUnpair && (
            <div className="flex items-center gap-2 px-2 py-1.5">
              <Palette className="h-4 w-4 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1 text-muted-foreground text-sm">主题</span>
              <div className="flex shrink-0 gap-0.5 rounded-md border p-0.5">
                {THEME_OPTIONS.map((option) => (
                  <button
                    key={option.value}
                    type="button"
                    onClick={() => setThemePreference(option.value)}
                    className={cn(
                      'rounded px-2 py-1 text-[11px] transition-colors',
                      themePref === option.value
                        ? 'bg-primary text-primary-foreground'
                        : 'text-muted-foreground hover:bg-accent'
                    )}
                  >
                    {option.label}
                  </button>
                ))}
              </div>
            </div>
          )}

          {confirmUnpair ? (
            <div className="space-y-2 rounded-lg border border-dashed p-3">
              <p className="text-xs">取消配对后需重新扫码才能连接，确定吗？</p>
              <div className="flex justify-end gap-2">
                <Button variant="outline" size="sm" onClick={() => setConfirmUnpair(false)}>
                  取消
                </Button>
                <Button variant="destructive" size="sm" onClick={onUnpair}>
                  确定解绑
                </Button>
              </div>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => setConfirmUnpair(true)}
              className="flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left text-muted-foreground text-sm transition-colors hover:bg-accent/50 hover:text-foreground"
            >
              <Unplug className="h-4 w-4 shrink-0" />
              <span className="min-w-0 flex-1 truncate">{deviceName}</span>
              <span
                className={cn(
                  'shrink-0 text-[10px]',
                  connected ? 'text-muted-foreground' : 'text-destructive'
                )}
              >
                {connectionLabel}
              </span>
            </button>
          )}
        </div>
      </aside>
    </>
  );
}

function ProjectGroup({
  name,
  sessions,
  childrenByParent,
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
  childrenByParent: Map<string, CatalogEntry[]>;
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
            <div key={session.id}>
              <button
                type="button"
                onClick={() => onSelect(session.id)}
                className={cn(
                  'flex w-full items-center gap-2 rounded-lg py-2 pr-2 pl-4 text-left text-sm transition-colors',
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
              {(childrenByParent.get(session.id) ?? []).map((child) => (
                <button
                  key={child.id}
                  type="button"
                  onClick={() => onSelect(child.id)}
                  className={cn(
                    'flex w-full items-center gap-2 rounded-lg py-1.5 pr-2 pl-8 text-left text-xs transition-colors',
                    activeId === child.id ? 'bg-muted' : 'hover:bg-muted/50'
                  )}
                >
                  <StatusDot status={child.status} />
                  <Bot className="h-3 w-3 shrink-0 text-muted-foreground" />
                  <span className="min-w-0 flex-1 truncate text-muted-foreground">
                    {child.title || 'coworker'}
                  </span>
                </button>
              ))}
            </div>
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
