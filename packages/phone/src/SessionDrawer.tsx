import { type CatalogEntry, type ProjectEntry, sshProjectLabel } from '@enso/pair';
import { orderPinned, orderProjectSessions, sortByActivity } from '@shared/pair/drawerOrder';
import {
  Archive,
  Bell,
  ChevronRight,
  FolderGit2,
  Laptop,
  MessageSquarePlus,
  Palette,
  Pencil,
  Pin,
  Plus,
  Unplug,
  X,
} from 'lucide-react';
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { formatRelativeTime } from '@/lib/time';
import { cn } from '@/lib/utils';
import type { StoredDevice } from './deviceList';
import type { PushFailureReason } from './push';
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

const PUSH_ERROR_TEXT: Record<PushFailureReason, string> = {
  unsupported: '当前浏览器不支持推送。',
  'permission-denied': '通知权限被拒绝，请在浏览器站点设置中允许后重试。',
  'service-unreachable': '无法连接 Google 推送服务（FCM），请检查网络或代理后重试。',
  'subscribe-failed': '订阅失败，请稍后重试。',
};

interface Props {
  open: boolean;
  projects: ProjectEntry[];
  catalog: CatalogEntry[];
  /** 桌面置顶组的手动拖拽顺序；缺省（旧桌面）按活跃倒序 */
  pinnedOrder?: string[];
  activeId: string | null;
  canCreate: boolean;
  /** 已配对的桌面列表（切换式：一次只连活跃那台） */
  devices: StoredDevice[];
  activeDevicePairId: string | null;
  /** 活跃那台的连接状态 */
  connected: boolean;
  connectionLabel: string;
  pushEnabled: boolean;
  /** 订阅进行中（权限弹框 + FCM 注册）：开关保持乐观已开但禁用 */
  pushBusy: boolean;
  /** 上次开启失败的原因；据此给出可自救的提示 */
  pushError: PushFailureReason | null;
  pushAvailability: 'ok' | 'needs-install' | 'unsupported';
  /** 已收到桌面的 push-config；旧版桌面不会发，此时开关禁用并提示升级 */
  pushConfigReady: boolean;
  onTogglePush(next: boolean): void;
  onClose(): void;
  onSelect(sessionId: string): void;
  onNewConversation(projectId: string): void;
  onSwitchDevice(pairId: string): void;
  onAddDevice(): void;
  onRenameDevice(pairId: string, label: string): void;
  /** 解绑指定那台；删到没有时回配对页 */
  onUnpairDevice(pairId: string): void;
}

export function SessionDrawer({
  open,
  projects,
  catalog,
  pinnedOrder = [],
  activeId,
  canCreate,
  devices,
  activeDevicePairId,
  connected,
  connectionLabel,
  pushEnabled,
  pushBusy,
  pushError,
  pushAvailability,
  pushConfigReady,
  onTogglePush,
  onClose,
  onSelect,
  onNewConversation,
  onSwitchDevice,
  onAddDevice,
  onRenameDevice,
  onUnpairDevice,
}: Props) {
  const [foldedProjects, setFoldedProjects] = useState<Record<string, boolean>>({});
  const [expandedProjects, setExpandedProjects] = useState<Record<string, boolean>>({});
  // 底部「已归档」栏目的折叠态（与桌面一致：缺省收起）
  const [archivedOpen, setArchivedOpen] = useState(false);
  /** 待确认解绑的 pairId；null = 无确认框 */
  const [confirmUnpair, setConfirmUnpair] = useState<string | null>(null);
  const [themePref, setThemePref] = useState<ThemePreference>(getThemePreference);

  // 主题可能由桌面下发触发变化，订阅后同步按钮高亮
  useEffect(() => subscribeTheme(() => setThemePref(getThemePreference())), []);

  // 抽屉关闭时收起确认态，避免下次打开还停在确认框
  useEffect(() => {
    if (!open) setConfirmUnpair(null);
  }, [open]);

  // 相对时间每分钟自刷（与桌面一致，避免「3 分钟前」僵住）
  const [nowTick, setNowTick] = useState(() => Date.now());
  useEffect(() => {
    if (!open) return;
    const timer = setInterval(() => setNowTick(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, [open]);

  // 与桌面侧栏同语义：归档不进项目组，只进底部栏目；置顶另起一栏且组内靠前；
  // 归档项目整组视为归档（会话自身标记不动，桌面恢复项目后原样回来）
  const archivedProjects = new Set(projects.filter((p) => p.archived).map((p) => p.id));
  const isArchived = (c: CatalogEntry) => c.archived || archivedProjects.has(c.projectId);
  const activeProjects = projects.filter((p) => !p.archived);
  const topLevel = catalog.filter((c) => !c.parentId);
  const pinnedSessions = orderPinned(
    topLevel.filter((c) => c.pinned && !isArchived(c)),
    pinnedOrder
  );
  const archivedSessions = sortByActivity(topLevel.filter(isArchived));
  const active = topLevel.filter((c) => !isArchived(c));

  // 没有项目归属的会话（项目已删等）单独归到「其他」
  const known = new Set(projects.map((p) => p.id));
  const orphans = orderProjectSessions(active.filter((c) => !known.has(c.projectId)));

  return (
    <>
      <button
        type="button"
        aria-label="关闭侧栏"
        onClick={onClose}
        // 关闭后要 visibility:hidden 而非只透明：iOS standalone 的状态栏底色采样页面顶边，
        // 仅改 opacity 不触发重采，会把遮罩色（黑 40% 叠白 = #999）卡在状态栏直到重开
        className={cn(
          'fixed inset-0 z-40 bg-black/40 transition-[opacity,visibility] duration-200',
          open ? 'visible opacity-100' : 'invisible pointer-events-none opacity-0'
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

          {pinnedSessions.length > 0 && (
            <div>
              <div className="flex items-center gap-1.5 px-2 py-2">
                <Pin className="h-3.5 w-3.5 text-muted-foreground" />
                <span className="font-medium text-sm">置顶</span>
              </div>
              <div className="flex flex-col gap-y-0.5">
                {pinnedSessions.map((session) => (
                  <SessionRow
                    key={session.id}
                    session={session}
                    active={activeId === session.id}
                    nowTick={nowTick}
                    onSelect={onSelect}
                  />
                ))}
              </div>
            </div>
          )}

          {activeProjects.map((project) => (
            <ProjectGroup
              key={project.id}
              name={project.name}
              badge={sshProjectLabel(project)}
              sessions={orderProjectSessions(active.filter((c) => c.projectId === project.id))}
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

        {/* 与桌面一致：归档栏固定底部（滚动区外），列表在折叠头上方向上展开 */}
        {archivedSessions.length > 0 && (
          <div className="shrink-0 border-t p-2">
            {archivedOpen && (
              <div className="mb-0.5 flex max-h-64 flex-col gap-y-0.5 overflow-y-auto">
                {archivedSessions.map((session) => (
                  <SessionRow
                    key={session.id}
                    session={session}
                    active={activeId === session.id}
                    nowTick={nowTick}
                    subtitle={projects.find((p) => p.id === session.projectId)?.name}
                    onSelect={onSelect}
                  />
                ))}
              </div>
            )}
            <button
              type="button"
              onClick={() => setArchivedOpen((prev) => !prev)}
              className="flex w-full items-center gap-1 rounded-lg px-2 py-2 text-left transition-colors hover:bg-accent/30"
            >
              <span className="flex h-5 w-5 shrink-0 items-center justify-center">
                <ChevronRight
                  className={cn(
                    'h-3.5 w-3.5 text-muted-foreground transition-transform duration-200',
                    archivedOpen ? '-rotate-90' : 'rotate-0'
                  )}
                />
              </span>
              <Archive className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate text-muted-foreground text-sm">已归档</span>
              <span className="shrink-0 text-[10px] text-muted-foreground">
                {archivedSessions.length}
              </span>
            </button>
          </div>
        )}

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

          {!confirmUnpair && (
            <div className="px-2 py-1.5">
              <div className="flex items-center gap-2">
                <Bell className="h-4 w-4 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1 text-muted-foreground text-sm">推送通知</span>
                <Switch
                  checked={pushEnabled}
                  disabled={pushBusy || pushAvailability !== 'ok' || !connected || !pushConfigReady}
                  onCheckedChange={onTogglePush}
                />
              </div>
              {pushBusy && <p className="mt-1 pl-6 text-[11px] text-muted-foreground">正在开启…</p>}
              {pushError && !pushBusy && (
                <p className="mt-1 pl-6 text-[11px] text-destructive">
                  {PUSH_ERROR_TEXT[pushError]}
                </p>
              )}
              {pushAvailability === 'ok' && connected && !pushConfigReady && (
                <p className="mt-1 pl-6 text-[11px] text-muted-foreground">
                  需先升级桌面端 EnsoCode 才能开启推送。
                </p>
              )}
              {pushAvailability === 'needs-install' && (
                <p className="mt-1 pl-6 text-[11px] text-muted-foreground">
                  iOS 需先用分享菜单「添加到主屏幕」，从主屏幕打开后才能开启。
                </p>
              )}
              {pushAvailability === 'unsupported' && (
                <p className="mt-1 pl-6 text-[11px] text-muted-foreground">
                  当前浏览器不支持推送。
                </p>
              )}
            </div>
          )}

          <div className="space-y-0.5">
            {devices.map((d) => {
              const isActive = d.pairId === activeDevicePairId;
              if (confirmUnpair === d.pairId) {
                return (
                  <div key={d.pairId} className="space-y-2 rounded-lg border border-dashed p-3">
                    <p className="text-xs">解绑「{d.label}」后需重新扫码才能连接，确定吗？</p>
                    <div className="flex justify-end gap-2">
                      <Button variant="outline" size="sm" onClick={() => setConfirmUnpair(null)}>
                        取消
                      </Button>
                      <Button
                        variant="destructive"
                        size="sm"
                        onClick={() => {
                          setConfirmUnpair(null);
                          onUnpairDevice(d.pairId);
                        }}
                      >
                        确定解绑
                      </Button>
                    </div>
                  </div>
                );
              }
              return (
                <div key={d.pairId} className="flex items-center gap-0.5">
                  <button
                    type="button"
                    onClick={() => onSwitchDevice(d.pairId)}
                    className={cn(
                      'flex min-w-0 flex-1 items-center gap-2 rounded-lg px-2 py-2 text-left text-sm transition-colors hover:bg-accent/50',
                      isActive ? 'text-foreground' : 'text-muted-foreground'
                    )}
                  >
                    <Laptop className="h-4 w-4 shrink-0" />
                    <span className="min-w-0 flex-1 truncate">{d.label}</span>
                    {isActive && (
                      <span
                        className={cn(
                          'shrink-0 text-[10px]',
                          connected ? 'text-muted-foreground' : 'text-destructive'
                        )}
                      >
                        {connectionLabel}
                      </span>
                    )}
                  </button>
                  <button
                    type="button"
                    aria-label={`重命名 ${d.label}`}
                    onClick={() => {
                      const label = window.prompt('给这台电脑起个名：', d.label);
                      if (label?.trim()) onRenameDevice(d.pairId, label);
                    }}
                    className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-muted-foreground/60 transition-colors hover:bg-accent hover:text-foreground"
                  >
                    <Pencil className="h-3.5 w-3.5" />
                  </button>
                  <button
                    type="button"
                    aria-label={`解绑 ${d.label}`}
                    onClick={() => setConfirmUnpair(d.pairId)}
                    className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-muted-foreground/60 transition-colors hover:bg-accent hover:text-destructive"
                  >
                    <Unplug className="h-3.5 w-3.5" />
                  </button>
                </div>
              );
            })}
            <button
              type="button"
              onClick={onAddDevice}
              className="flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left text-muted-foreground text-sm transition-colors hover:bg-accent/50 hover:text-foreground"
            >
              <Plus className="h-4 w-4 shrink-0" />
              <span>配对新电脑</span>
            </button>
          </div>

          <p className="px-2 pt-0.5 text-center text-[10px] text-muted-foreground/60">
            版本 {__COMMIT__}
          </p>
        </div>
      </aside>
    </>
  );
}

/** 置顶/归档/项目组共用的会话行（subtitle = 归档栏内联的项目名，与桌面一致） */
function SessionRow({
  session,
  active,
  nowTick,
  subtitle,
  onSelect,
}: {
  session: CatalogEntry;
  active: boolean;
  nowTick: number;
  subtitle?: string;
  onSelect(id: string): void;
}) {
  return (
    <button
      type="button"
      onClick={() => onSelect(session.id)}
      className={cn(
        'flex w-full items-center gap-2 rounded-lg py-2 pr-2 pl-4 text-left text-sm transition-colors',
        active ? 'bg-muted' : 'hover:bg-muted/50'
      )}
    >
      <StatusDot status={session.status} unread={session.unread} />
      <span className="min-w-0 flex-1 truncate">
        {session.title || '新对话'}
        {subtitle && <span className="ml-1.5 text-[10px] text-muted-foreground">{subtitle}</span>}
      </span>
      {session.updatedAt && (
        <span className="shrink-0 text-[10px] text-muted-foreground">
          {formatRelativeTime(session.updatedAt, 'zh', nowTick)}
        </span>
      )}
    </button>
  );
}

function ProjectGroup({
  name,
  badge,
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
  badge?: string;
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
          <span className="min-w-0 flex-1 truncate font-medium text-sm">
            {name}
            {badge && (
              <span className="ml-1.5 rounded bg-muted px-1 py-0.5 text-[10px] font-normal text-muted-foreground">
                {badge}
              </span>
            )}
          </span>
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
            <SessionRow
              key={session.id}
              session={session}
              active={activeId === session.id}
              nowTick={nowTick}
              onSelect={onSelect}
            />
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
function StatusDot({ status, unread }: { status: string; unread?: boolean }) {
  const running = status === 'running';
  const failed = !running && status === 'failed';
  const showUnread = !running && !failed && unread === true;
  return (
    <span
      className={cn(
        'h-1.5 w-1.5 shrink-0 rounded-full',
        running && 'animate-pulse bg-blue-500',
        failed && 'bg-destructive',
        showUnread && 'bg-green-500',
        !running && !failed && !showUnread && 'bg-muted-foreground/30'
      )}
    />
  );
}
