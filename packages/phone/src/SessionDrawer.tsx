import {
  type CatalogEntry,
  type ProjectEntry,
  type ProjectGroupEntry,
  pairProjectDisplayName,
  sshProjectLabel,
} from '@enso/pair';
import { archiveScopeForTab, filterArchivedByScope } from '@shared/archiveScope';
import {
  orderDrawerActive,
  orderPinned,
  orderProjectSessions,
  sortByActivity,
} from '@shared/pair/drawerOrder';
import {
  ALL_GROUP_ID,
  filterProjectsByGroup,
  sectionsForAllView,
  UNGROUPED_GROUP_ID,
} from '@shared/projectGroups';
import {
  AlarmClock,
  Archive,
  Bell,
  BellOff,
  ChevronRight,
  FolderGit2,
  Laptop,
  MessageSquarePlus,
  Monitor,
  Palette,
  PanelLeftClose,
  PanelLeftOpen,
  Pencil,
  PictureInPicture2,
  Pin,
  Plus,
  Unplug,
  X,
} from 'lucide-react';
import { type ReactNode, useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { useI18n } from '@/i18n';
import { formatRelativeTime } from '@/lib/time';
import { cn } from '@/lib/utils';
import { Z_INDEX } from '@/lib/z-index';
import {
  COLLAPSED_SESSION_LIMIT,
  nextRevealedExtra,
  prevRevealedExtra,
  shownConversationCount,
} from '@/stores/sessions/sessionSwitchSlots';
import type { StoredDevice } from './deviceList';
import type { PushFailureReason } from './push';
import { pushHints } from './pushToggle';
import {
  getThemePreference,
  setThemePreference,
  subscribeTheme,
  type ThemePreference,
} from './theme';
import { deskUrl } from './uiMode';

/**
 * 手机侧边栏：复刻桌面 Sidebar 的项目分组结构（chevron / 仓库图标 / 状态点 /
 * 相对时间 / 折叠更多），改为抽屉式呈现。桌面版的加项目、导入、删除属于
 * 宿主能力，手机端不提供。
 */

/** auto = 跟随桌面下发；其余为本地覆盖 */
const THEME_OPTIONS: { value: ThemePreference; label: string }[] = [
  { value: 'auto', label: '跟随桌面' },
  { value: 'light', label: '浅' },
  { value: 'dark', label: '深' },
];

interface Props {
  open: boolean;
  /** 大屏横屏：左栏常驻布局，不渲染遮罩、无关闭按钮，onClose 由调用方保持空操作 */
  docked?: boolean;
  /** 当前窗口满足常驻条件：显示 常驻/折叠 切换入口 */
  pinnable?: boolean;
  /** 切换 常驻/折叠；调用方负责持久化 */
  onTogglePinned?(): void;
  projects: ProjectEntry[];
  groups?: ProjectGroupEntry[];
  catalog: CatalogEntry[];
  /** 桌面置顶组的手动拖拽顺序；缺省（旧桌面）按活跃倒序 */
  pinnedOrder?: string[];
  activeId: string | null;
  canCreate: boolean;
  /** 已配对的桌面列表（切换式：一次只连活跃那台） */
  devices: StoredDevice[];
  activeDevicePairId: string | null;
  /** 当前桌面支持桌面模式（旧桌面不显示入口） */
  remoteDesktop?: boolean;
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
  /** iOS 原生壳的画中画实时对话浮窗；浏览器 / PWA 不传 */
  pip?: {
    active: boolean;
    auto: boolean;
    aspect?: 'portrait' | 'square' | 'landscape';
    follow?: 'opened' | 'latest';
    supported: boolean;
    error?: string | null;
    onToggle(): void;
    onAutoChange(next: boolean): void;
    onAspectChange?(aspect: 'portrait' | 'square' | 'landscape'): void;
    onFollowChange?(mode: 'opened' | 'latest'): void;
  };
  onClose(): void;
  onSelect(sessionId: string): void;
  onNewConversation(projectId: string): void;
  onSwitchDevice(pairId: string): void;
  onAddDevice(): void;
  onRenameDevice(pairId: string, label: string): void;
  /** 解绑指定那台；删到没有时回配对页 */
  onUnpairDevice(pairId: string): void;
  /** 桌面开启 Bot 模式后才有：顶部切换「项目 | Bot」 */
  botSegment?: { active: boolean; onChange(active: boolean): void; panel: ReactNode };
}

export function SessionDrawer({
  open,
  docked = false,
  pinnable = false,
  onTogglePinned,
  projects,
  groups = [],
  catalog,
  pinnedOrder = [],
  activeId,
  canCreate,
  devices,
  activeDevicePairId,
  remoteDesktop,
  connected,
  connectionLabel,
  pushEnabled,
  pushBusy,
  pushError,
  pushAvailability,
  pushConfigReady,
  onTogglePush,
  pip,
  onClose,
  onSelect,
  onNewConversation,
  onSwitchDevice,
  onAddDevice,
  onRenameDevice,
  onUnpairDevice,
  botSegment,
}: Props) {
  const botActive = botSegment?.active === true;
  const [foldedProjects, setFoldedProjects] = useState<Record<string, boolean>>({});
  const [revealedExtras, setRevealedExtras] = useState<Record<string, number>>({});
  // 底部「已归档」栏目的折叠态（与桌面一致：缺省收起）
  const [archivedOpen, setArchivedOpen] = useState(false);
  // 归档栏默认按当前分组过滤；展开后可临时看全部，换分组即复位
  const [archivedShowAll, setArchivedShowAll] = useState(false);
  /** 待确认解绑的 pairId；null = 无确认框 */
  const [confirmUnpair, setConfirmUnpair] = useState<string | null>(null);
  const deskDevice = remoteDesktop
    ? devices.find((d) => d.pairId === activeDevicePairId && d.scope !== 'read')
    : undefined;
  const [themePref, setThemePref] = useState<ThemePreference>(getThemePreference);
  const [selectedGroupId, setSelectedGroupId] = useState(() => {
    try {
      return localStorage.getItem('enso-phone-selected-project-group') ?? ALL_GROUP_ID;
    } catch {
      return ALL_GROUP_ID;
    }
  });
  const [collapsedGroupIds, setCollapsedGroupIds] = useState<Record<string, boolean>>({});
  const resolvedGroupId =
    selectedGroupId === ALL_GROUP_ID ||
    selectedGroupId === UNGROUPED_GROUP_ID ||
    groups.some((group) => group.id === selectedGroupId)
      ? selectedGroupId
      : ALL_GROUP_ID;
  // biome-ignore lint/correctness/useExhaustiveDependencies: 换分组时复位
  useEffect(() => setArchivedShowAll(false), [resolvedGroupId]);

  // 主题可能由桌面下发触发变化，订阅后同步按钮高亮
  useEffect(() => subscribeTheme(() => setThemePref(getThemePreference())), []);

  // 抽屉关闭时收起确认态，避免下次打开还停在确认框
  useEffect(() => {
    if (!open) setConfirmUnpair(null);
  }, [open]);

  // 相对时间每分钟自刷。抽屉关闭时停表；再打开必须先刷 now，否则会拿着冻结基准
  // 把更新过的会话算成未来（「x 小时后」）。杀进程重挂看起来像「同步好了」。
  const [nowTick, setNowTick] = useState(() => Date.now());
  useEffect(() => {
    if (!open) return;
    setNowTick(Date.now());
    const timer = setInterval(() => setNowTick(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, [open]);

  // 与桌面侧栏同语义：归档不进项目组，只进底部栏目；置顶另起一栏且组内靠前；
  // 归档项目整组视为归档（会话自身标记不动，桌面恢复项目后原样回来）
  const archivedProjects = new Set(projects.filter((p) => p.archived).map((p) => p.id));
  const archivedProjectIds = [...archivedProjects];
  const isArchived = (c: CatalogEntry) => c.archived || archivedProjects.has(c.projectId);
  const activeProjects = filterProjectsByGroup(
    projects,
    groups,
    archivedProjectIds,
    resolvedGroupId
  );
  const groupSections = sectionsForAllView(projects, groups, archivedProjectIds);
  const slicedIdSet = new Set(activeProjects.map((project) => project.id));
  const topLevel = catalog.filter((c) => !c.parentId);
  const inSlice = (c: CatalogEntry) => !c.projectId || slicedIdSet.has(c.projectId);
  const hasRunningChild = (id: string) =>
    catalog.some((child) => child.parentId === id && child.status === 'running');
  const activeSessions = orderDrawerActive(
    topLevel.filter((c) => !isArchived(c) && inSlice(c)),
    hasRunningChild
  );
  const pinnedSessions = orderPinned(
    topLevel.filter((c) => c.pinned && !isArchived(c) && inSlice(c)),
    pinnedOrder
  );
  const allArchived = sortByActivity(topLevel.filter(isArchived));
  const tabArchiveScope = archiveScopeForTab(resolvedGroupId, groups);
  const tabArchivedIds = new Set(
    filterArchivedByScope(
      allArchived.map((c) => ({ projectId: c.projectId, ids: [c.id] })),
      tabArchiveScope,
      { projects, projectGroups: groups, conversations: {} }
    ).flatMap((group) => group.ids)
  );
  const tabArchived = allArchived.filter((c) => tabArchivedIds.has(c.id));
  const scopedTab = tabArchiveScope.kind !== 'all';
  const archivedSessions = archivedShowAll ? allArchived : tabArchived;
  const archivedScopeLabel =
    !scopedTab || archivedShowAll
      ? '范围：全部归档'
      : tabArchiveScope.kind === 'group'
        ? `范围：分组「${groups.find((group) => group.id === tabArchiveScope.groupId)?.name ?? ''}」的归档`
        : '范围：未分组项目的归档';
  const active = topLevel.filter((c) => !isArchived(c));

  // 没有项目归属的会话（项目已删等）单独归到「其他」
  const known = new Set(projects.map((p) => p.id));
  const orphans = orderProjectSessions(active.filter((c) => !known.has(c.projectId)));

  return (
    <>
      {!docked && (
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
      )}
      <aside
        className={cn(
          'flex shrink-0 flex-col border-r bg-background',
          docked
            ? 'relative h-full w-72'
            : cn(
                'fixed inset-y-0 left-0 z-50 w-[82vw] max-w-xs transition-transform duration-200',
                open ? 'translate-x-0' : '-translate-x-full'
              )
        )}
      >
        <div
          className={cn(
            'flex h-12 shrink-0 items-center justify-between px-3 pt-safe',
            groups.length === 0 && 'border-b'
          )}
        >
          {botSegment ? (
            <span className="flex rounded-lg bg-muted p-0.5 text-sm">
              {(['项目', 'Bot'] as const).map((label) => {
                const selected = (label === 'Bot') === botSegment.active;
                return (
                  <button
                    key={label}
                    type="button"
                    aria-pressed={selected}
                    onClick={() => botSegment.onChange(label === 'Bot')}
                    className={cn(
                      'rounded-md px-3 py-0.5 transition-colors',
                      selected ? 'bg-background font-medium shadow-xs' : 'text-muted-foreground'
                    )}
                  >
                    {label}
                  </button>
                );
              })}
            </span>
          ) : (
            <span className="font-medium text-sm">项目</span>
          )}
          {docked ? (
            pinnable && onTogglePinned ? (
              <button
                type="button"
                onClick={onTogglePinned}
                aria-label="收起侧栏"
                className="rounded-md p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              >
                <PanelLeftClose className="h-4 w-4" />
              </button>
            ) : null
          ) : (
            <span className="flex items-center">
              {pinnable && onTogglePinned && (
                <button
                  type="button"
                  onClick={onTogglePinned}
                  aria-label="固定侧栏"
                  className="rounded-md p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                >
                  <PanelLeftOpen className="h-4 w-4" />
                </button>
              )}
              <button
                type="button"
                onClick={onClose}
                aria-label="关闭侧栏"
                className="rounded-md p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              >
                <X className="h-4 w-4" />
              </button>
            </span>
          )}
        </div>
        {!botActive && groups.length > 0 && (
          <div className="shrink-0 border-b px-3 pb-2">
            <Select
              items={[
                { value: ALL_GROUP_ID, label: '全部' },
                ...groups
                  .slice()
                  .sort((a, b) => a.order - b.order)
                  .map((group) => ({
                    value: group.id,
                    label: `${group.emoji ? `${group.emoji} ` : ''}${group.name}`,
                  })),
                { value: UNGROUPED_GROUP_ID, label: '未分组' },
              ]}
              value={resolvedGroupId}
              onValueChange={(value) => {
                if (!value) return;
                setSelectedGroupId(value);
                try {
                  localStorage.setItem('enso-phone-selected-project-group', value);
                } catch {
                  /* ignore */
                }
              }}
            >
              <SelectTrigger className="w-full" size="sm">
                <SelectValue />
              </SelectTrigger>
              <SelectPopup zIndex={Z_INDEX.DROPDOWN_IN_MODAL}>
                <SelectItem value={ALL_GROUP_ID}>全部</SelectItem>
                {groups
                  .slice()
                  .sort((a, b) => a.order - b.order)
                  .map((group) => (
                    <SelectItem key={group.id} value={group.id}>
                      {group.emoji ? `${group.emoji} ` : ''}
                      {group.name}
                    </SelectItem>
                  ))}
                <SelectItem value={UNGROUPED_GROUP_ID}>未分组</SelectItem>
              </SelectPopup>
            </Select>
          </div>
        )}

        {botActive ? (
          botSegment?.panel
        ) : (
          <div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-2">
            {projects.length === 0 && (
              <p className="rounded-lg border border-dashed px-3 py-6 text-center text-muted-foreground text-sm">
                桌面端还没有项目
              </p>
            )}

            {activeSessions.length > 0 && (
              <div>
                <div className="flex items-center gap-1.5 px-2 py-2">
                  <span className="font-medium text-sm">活跃中</span>
                </div>
                <div className="flex flex-col gap-y-0.5">
                  {activeSessions.map((session) => (
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

            {(resolvedGroupId === ALL_GROUP_ID && groups.length > 0
              ? groupSections.flatMap((section) => {
                  const folded = collapsedGroupIds[section.groupId] === true;
                  return [
                    { kind: 'header' as const, section, folded },
                    ...(folded
                      ? []
                      : section.projects.map((project) => ({ kind: 'project' as const, project }))),
                  ];
                })
              : activeProjects.map((project) => ({ kind: 'project' as const, project }))
            ).map((item) =>
              item.kind === 'header' ? (
                <button
                  key={`hdr-${item.section.groupId}`}
                  type="button"
                  onClick={() =>
                    setCollapsedGroupIds((prev) => ({
                      ...prev,
                      [item.section.groupId]: !prev[item.section.groupId],
                    }))
                  }
                  className="flex h-7 w-full items-center gap-1 rounded-md px-2 text-left text-xs font-medium text-muted-foreground"
                >
                  <ChevronRight
                    className={cn(
                      'h-3.5 w-3.5 shrink-0 transition-transform duration-150',
                      !item.folded && 'rotate-90'
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
                    {item.section.group?.name ?? '未分组'}
                  </span>
                  <span className="shrink-0 text-[10px] text-muted-foreground/70">
                    {item.section.projects.length}
                  </span>
                </button>
              ) : (
                <ProjectGroup
                  key={item.project.id}
                  name={pairProjectDisplayName(item.project)}
                  badge={sshProjectLabel(item.project)}
                  sessions={orderProjectSessions(
                    active.filter((c) => c.projectId === item.project.id)
                  )}
                  folded={foldedProjects[item.project.id] === true}
                  revealedExtra={revealedExtras[item.project.id] ?? 0}
                  activeId={activeId}
                  nowTick={nowTick}
                  canCreate={canCreate}
                  onToggleFold={() =>
                    setFoldedProjects((prev) => ({
                      ...prev,
                      [item.project.id]: !prev[item.project.id],
                    }))
                  }
                  onRevealMore={(next) =>
                    setRevealedExtras((prev) => ({ ...prev, [item.project.id]: next }))
                  }
                  onSelect={onSelect}
                  onNew={() => onNewConversation(item.project.id)}
                />
              )
            )}

            {orphans.length > 0 && (
              <ProjectGroup
                name="其他"
                sessions={orphans}
                folded={foldedProjects.__orphan === true}
                revealedExtra={revealedExtras.__orphan ?? 0}
                activeId={activeId}
                nowTick={nowTick}
                canCreate={false}
                onToggleFold={() =>
                  setFoldedProjects((prev) => ({ ...prev, __orphan: !prev.__orphan }))
                }
                onRevealMore={(next) => setRevealedExtras((prev) => ({ ...prev, __orphan: next }))}
                onSelect={onSelect}
              />
            )}
          </div>
        )}

        {/* 与桌面一致：归档栏固定底部（滚动区外），列表在折叠头上方向上展开；每个分组都常驻，0 条时弱化 */}
        {!botActive && (
          <div className="shrink-0 border-t p-2">
            {archivedOpen && (
              <div className="mb-0.5 flex max-h-64 flex-col gap-y-0.5 overflow-y-auto">
                <div className="flex items-center gap-2 px-2 py-1">
                  <span
                    data-slot="archive-scope"
                    className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground"
                  >
                    {archivedScopeLabel}
                  </span>
                  {scopedTab && (
                    <button
                      type="button"
                      onClick={() => setArchivedShowAll((prev) => !prev)}
                      className="shrink-0 rounded-full border px-2 py-0.5 text-[11px] text-muted-foreground transition-colors hover:bg-muted/60"
                    >
                      {archivedShowAll ? '仅本分组' : '全部归档'}
                    </button>
                  )}
                </div>
                {archivedSessions.length === 0 && (
                  <p className="px-2 py-3 text-center text-muted-foreground text-xs">
                    没有归档会话
                  </p>
                )}
                {archivedSessions.map((session) => (
                  <SessionRow
                    key={session.id}
                    session={session}
                    active={activeId === session.id}
                    nowTick={nowTick}
                    subtitle={(() => {
                      const project = projects.find((p) => p.id === session.projectId);
                      return project ? pairProjectDisplayName(project) : undefined;
                    })()}
                    onSelect={onSelect}
                  />
                ))}
              </div>
            )}
            <button
              type="button"
              data-slot="archived-button"
              data-empty={tabArchived.length === 0 || undefined}
              onClick={() => setArchivedOpen((prev) => !prev)}
              className={cn(
                'flex w-full items-center gap-1 rounded-lg px-2 py-2 text-left transition-colors hover:bg-muted/60',
                tabArchived.length === 0 && 'opacity-55'
              )}
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
              <span className="shrink-0 text-[10px] text-muted-foreground tabular-nums">
                {tabArchived.length}
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

          {!confirmUnpair && deskDevice && (
            <div className="flex items-center gap-2 px-2 py-1.5">
              <Monitor className="h-4 w-4 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1 text-muted-foreground text-sm">界面</span>
              <div className="flex shrink-0 gap-0.5 rounded-md border p-0.5">
                <span className="rounded bg-primary px-2 py-1 text-[11px] text-primary-foreground">
                  精简
                </span>
                <button
                  type="button"
                  onClick={() => {
                    window.location.href = deskUrl(deskDevice.pairId);
                  }}
                  className="rounded px-2 py-1 text-[11px] text-muted-foreground transition-colors hover:bg-accent"
                >
                  完整
                </button>
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
              {pushHints({
                busy: pushBusy,
                error: pushError,
                availability: pushAvailability,
                connected,
                configReady: pushConfigReady,
              }).map((hint) => (
                <p
                  key={hint.text}
                  className={cn(
                    'mt-1 pl-6 text-[11px]',
                    hint.error ? 'text-destructive' : 'text-muted-foreground'
                  )}
                >
                  {hint.text}
                </p>
              ))}
            </div>
          )}

          {!confirmUnpair && pip && (
            <div className="px-2 py-1.5">
              <button
                type="button"
                disabled={!pip.supported}
                onClick={pip.onToggle}
                className="flex w-full items-center gap-2 text-left text-sm disabled:opacity-50"
              >
                <PictureInPicture2 className="h-4 w-4 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1 text-muted-foreground">
                  {pip.active ? '关闭画中画浮窗' : '开启画中画浮窗'}
                </span>
              </button>
              <div className="mt-2 flex items-center gap-2 pl-6">
                <span className="min-w-0 flex-1 text-muted-foreground text-sm">
                  切后台自动画中画
                </span>
                <Switch
                  checked={pip.auto}
                  disabled={!pip.supported}
                  onCheckedChange={pip.onAutoChange}
                />
              </div>
              {pip.onAspectChange && (
                <div className="mt-2 flex items-center gap-2 pl-6">
                  <span className="min-w-0 flex-1 text-muted-foreground text-sm">浮窗比例</span>
                  <div
                    className="inline-flex shrink-0 items-center gap-0.5 rounded-md bg-muted p-0.5"
                    role="group"
                    aria-label="浮窗比例"
                  >
                    {(
                      [
                        { id: 'portrait', label: '竖屏大窗' },
                        { id: 'square', label: '方形' },
                        { id: 'landscape', label: '横屏' },
                      ] as const
                    ).map((opt) => {
                      const selected = (pip.aspect ?? 'portrait') === opt.id;
                      return (
                        <button
                          key={opt.id}
                          type="button"
                          disabled={!pip.supported}
                          aria-pressed={selected}
                          onClick={() => pip.onAspectChange?.(opt.id)}
                          className={cn(
                            'rounded px-1.5 py-0.5 text-[11px] transition-colors',
                            selected
                              ? 'bg-background font-semibold text-foreground shadow-xs'
                              : 'text-muted-foreground'
                          )}
                        >
                          {opt.label}
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}
              {pip.onFollowChange && (
                <div className="mt-2 flex items-center gap-2 pl-6">
                  <span className="min-w-0 flex-1 text-muted-foreground text-sm">跟随会话</span>
                  <div
                    className="inline-flex shrink-0 items-center gap-0.5 rounded-md bg-muted p-0.5"
                    role="group"
                    aria-label="跟随会话"
                  >
                    {(
                      [
                        { id: 'opened', label: '当前打开' },
                        { id: 'latest', label: '最新活跃' },
                      ] as const
                    ).map((opt) => {
                      const selected = (pip.follow ?? 'opened') === opt.id;
                      return (
                        <button
                          key={opt.id}
                          type="button"
                          disabled={!pip.supported}
                          aria-pressed={selected}
                          onClick={() => pip.onFollowChange?.(opt.id)}
                          className={cn(
                            'rounded px-1.5 py-0.5 text-[11px] transition-colors',
                            selected
                              ? 'bg-background font-semibold text-foreground shadow-xs'
                              : 'text-muted-foreground'
                          )}
                        >
                          {opt.label}
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}
              <p className="mt-1 pl-6 text-[11px] text-muted-foreground">
                {pip.error || '浮窗支持双指放大，切到其他 App 时实时同步对话'}
              </p>
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
                      'flex min-w-0 flex-1 items-center gap-2 rounded-lg px-2 py-2 text-left text-sm transition-colors hover:bg-muted/60',
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
              className="flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left text-muted-foreground text-sm transition-colors hover:bg-muted/60 hover:text-foreground"
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
        active ? 'bg-brand/10 dark:bg-brand/15' : 'hover:bg-muted/60'
      )}
    >
      <StatusDot
        status={session.status}
        unread={session.unread}
        conversationId={session.id}
        queuePosition={session.queuePosition}
        queueFailed={session.queueFailed}
      />
      {session.pinned && <Pin className="h-3 w-3 shrink-0 text-muted-foreground" aria-hidden />}
      {session.muted && (
        <BellOff className="h-3 w-3 shrink-0 text-muted-foreground" aria-label="静音" />
      )}
      <span className="min-w-0 flex-1 truncate">
        {session.title || '新对话'}
        {subtitle && <span className="ml-1.5 text-[10px] text-muted-foreground">{subtitle}</span>}
      </span>
      {session.updatedAt && (
        <span className="shrink-0 text-[10px] text-muted-foreground/80 tabular-nums">
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
  revealedExtra,
  activeId,
  nowTick,
  canCreate,
  onToggleFold,
  onRevealMore,
  onSelect,
  onNew,
}: {
  name: string;
  badge?: string;
  sessions: CatalogEntry[];
  folded: boolean;
  revealedExtra: number;
  activeId: string | null;
  nowTick: number;
  canCreate: boolean;
  onToggleFold(): void;
  onRevealMore(next: number): void;
  onSelect(id: string): void;
  onNew?(): void;
}) {
  const { t } = useI18n();
  const shownCount = shownConversationCount(sessions.length, revealedExtra);
  const shown = sessions.slice(0, shownCount);
  const hidden = sessions.length - shownCount;
  return (
    <div>
      <div className="flex w-full items-center gap-1 rounded-lg px-2 py-2 transition-colors hover:bg-muted/60">
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
          <span className="shrink-0 text-[10px] text-muted-foreground tabular-nums">
            {sessions.length}
          </span>
        </button>
        {canCreate && onNew && (
          <button
            type="button"
            onClick={onNew}
            className="shrink-0 rounded-md p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
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
            <div className="flex items-center gap-1">
              {hidden > 0 && (
                <button
                  type="button"
                  onClick={() => onRevealMore(nextRevealedExtra(sessions.length, revealedExtra))}
                  className="flex-1 rounded-lg py-1 text-center text-muted-foreground text-xs transition-colors hover:bg-muted/60 hover:text-foreground"
                >
                  {t('Show {{n}} more', { n: hidden })}
                </button>
              )}
              {revealedExtra > 0 && (
                <button
                  type="button"
                  onClick={() => onRevealMore(prevRevealedExtra(revealedExtra))}
                  className="flex-1 rounded-lg py-1 text-center text-muted-foreground text-xs transition-colors hover:bg-muted/60 hover:text-foreground"
                >
                  {t('Collapse')}
                </button>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** 与桌面 ConversationDot 同款 */
function StatusDot({
  status,
  unread,
  conversationId,
  queuePosition,
  queueFailed,
}: {
  status: string;
  unread?: boolean;
  conversationId?: string;
  queuePosition?: number;
  queueFailed?: string;
}) {
  const { t } = useI18n();
  if (status === 'queued' && !queueFailed) {
    const title = t('Queued · #{{n}}, starts automatically when a slot opens', {
      n: queuePosition ?? 1,
    });
    return (
      <AlarmClock
        className="h-3.5 w-3.5 shrink-0 text-orange-500"
        aria-label={title}
        title={title}
        data-enso="conversation-queued"
        data-conversation-id={conversationId}
        data-tone="queued"
      />
    );
  }
  const running = status === 'running';
  const failed = !running && (status === 'failed' || (status === 'queued' && Boolean(queueFailed)));
  const showUnread = !running && !failed && unread === true;
  return (
    <span
      title={queueFailed}
      className={cn(
        'h-1.5 w-1.5 shrink-0 rounded-full',
        running && 'animate-pulse bg-brand',
        failed && 'bg-destructive',
        showUnread && 'bg-green-500',
        !running && !failed && !showUnread && 'bg-muted-foreground/30'
      )}
    />
  );
}
