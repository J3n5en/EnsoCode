import { ChevronDown, Plus, RefreshCw, Settings } from 'lucide-react';
import type * as React from 'react';
import {
  ContextMenu,
  ContextMenuItem,
  ContextMenuPopup,
  ContextMenuTrigger,
} from '@/components/ui/context-menu';
import { Menu, MenuItem, MenuPopup, MenuTrigger } from '@/components/ui/menu';
import { useI18n } from '@/i18n';
import { cn } from '@/lib/utils';
import { SecretaryAvatar } from './SecretaryAvatar';
import type { RunningOriginsLink } from './SecretaryRunningOrigins';
import { type SecretarySectionView, SecretarySummary } from './secretaryView';

const ACTION_CLASS =
  'flex size-5 shrink-0 items-center justify-center rounded-[5px] text-muted-foreground transition-colors hover:bg-foreground/5 hover:text-foreground';

/**
 * 多个秘书时的整块标题：「秘书 (n)」+ 折叠箭头 + 新建。
 * 折叠后只留标题行与合计的「等你」徽标，单个秘书时不渲染（保持原来的一行）。
 */
export function SecretaryGroupHeader({
  count,
  folded,
  needsYou,
  onToggleFold,
  onCreate,
}: {
  count: number;
  folded: boolean;
  needsYou: number;
  onToggleFold: () => void;
  onCreate: () => void;
}) {
  const { t } = useI18n();
  return (
    <div
      data-enso="secretary-group"
      data-expanded={!folded || undefined}
      className="group flex w-full items-center gap-1 px-2 py-1"
    >
      <button
        type="button"
        data-enso="secretary-group-fold"
        onClick={onToggleFold}
        aria-expanded={!folded}
        className="flex min-w-0 flex-1 items-center gap-1 text-left text-[11.5px] font-medium text-muted-foreground"
      >
        {/* 箭头常显，与「临时会话」分组一致；折叠只旋转，文字不跟着挪 */}
        <ChevronDown
          data-enso="secretary-group-chevron"
          className={cn(
            'size-3 shrink-0 text-subtle-foreground transition-[opacity,transform] duration-150',
            folded ? '-rotate-90 opacity-100' : 'opacity-70 group-hover:opacity-100'
          )}
        />
        <span className="truncate">
          {t('Secretary')} ({count})
        </span>
      </button>
      {folded && needsYou > 0 && (
        <span data-enso="secretary-badge" className="shrink-0 text-[11px] font-medium text-warning">
          {t('{{n}} waiting', { n: needsYou })}
        </span>
      )}
      <button
        type="button"
        data-enso="secretary-group-create"
        onClick={onCreate}
        title={t('New secretary')}
        aria-label={t('New secretary')}
        className={SECTION_ACTION_CLASS}
      >
        <Plus className="size-3.5" />
      </button>
    </div>
  );
}

const SECTION_ACTION_CLASS =
  '-my-0.5 flex size-5 shrink-0 items-center justify-center rounded-[5px] text-subtle-foreground opacity-0 transition-opacity hover:bg-foreground/5 hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100';

/** 秘书是置顶伪项目：不投进普通项目列表，否则会受分组筛选与拖拽排序影响 */
export function sidebarProjects<T extends { kind?: string }>(projects: readonly T[]): T[] {
  return projects.filter((project) => project.kind !== 'scratch' && project.kind !== 'secretary');
}

export interface SecretarySectionActions {
  onToggleFold: () => void;
  onOpen: () => void;
  onNewConversation: () => void;
  onOpenSettings: () => void;
  onReset: () => void;
}

/**
 * 置顶伪项目的人物卡：外观与项目行不同，只有头像、名字与一行摘要。
 * 折叠箭头与 ⚙/＋ 只在 hover 时出现；会话行由侧栏传入，与卡片左对齐。
 * 触屏没有悬停：头像始终露出，折叠箭头改放行尾。
 */
export function SecretarySidebarSection({
  view,
  folded,
  onToggleFold,
  onOpen,
  onNewConversation,
  onOpenSettings,
  onReset,
  runningOrigins,
  divider = true,
  secretaryId,
  keepAvatar = false,
  children,
}: SecretarySectionActions & {
  view: SecretarySectionView;
  folded: boolean;
  runningOrigins?: RunningOriginsLink;
  /** 多个秘书时只有最后一个分区画分隔线 */
  divider?: boolean;
  /** 多个秘书时标出是哪一个 */
  secretaryId?: string;
  /**
   * 多个秘书时：折叠后头像留着，箭头平时不显示，悬停或键盘聚焦才叠在头像上。
   * 只有一个秘书时不传，维持箭头在悬停时顶掉头像的样子。
   */
  keepAvatar?: boolean;
  children: React.ReactNode;
}) {
  const { t } = useI18n();
  const foldLabel = folded ? t('Expand') : t('Collapse');
  const row = (
    <div
      data-enso="secretary-row"
      data-expanded={!folded || undefined}
      className="group flex w-full items-center gap-2.5 rounded-[10px] px-2 py-1.5 transition-colors hover:bg-foreground/5"
    >
      {/* 箭头不占布局宽度，人物卡才和下面的会话行左对齐 */}
      <button
        type="button"
        data-enso="secretary-fold"
        onClick={onToggleFold}
        aria-expanded={!folded}
        aria-label={foldLabel}
        title={foldLabel}
        className={cn('shrink-0 rounded-[9px]', keepAvatar && 'relative')}
      >
        <span
          className={cn(
            'block',
            !keepAvatar && (folded ? 'hidden [@media(hover:none)]:block' : 'group-hover:hidden')
          )}
        >
          <SecretaryAvatar
            name={view.name}
            color={view.color}
            image={view.image}
            needsYou={view.needsYou}
            running={view.running}
          />
        </span>
        <span
          data-enso="secretary-fold-icon"
          className={cn(
            'size-7 items-center justify-center rounded-[9px] bg-muted text-muted-foreground [@media(hover:none)]:hidden!',
            keepAvatar
              ? 'absolute inset-0 hidden group-hover:flex group-has-[:focus-visible]:flex'
              : folded
                ? 'flex'
                : 'hidden group-hover:flex'
          )}
        >
          <ChevronDown className={cn('size-3.5', folded && '-rotate-90')} />
        </span>
      </button>
      <button
        type="button"
        data-enso="secretary-open"
        onClick={() => onOpen()}
        title={view.name}
        className="flex min-w-0 flex-1 flex-col items-start text-left"
      >
        <span className="block max-w-full truncate text-[13px] font-medium text-foreground">
          {view.name}
        </span>
        <span
          data-enso="secretary-summary"
          className="mt-0.5 flex max-w-full min-w-0 items-center truncate text-[11.5px] text-muted-foreground"
        >
          <SecretarySummary view={view} origins={runningOrigins} />
        </span>
      </button>
      <span className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
        <button
          type="button"
          data-enso="secretary-action"
          data-action="settings"
          onClick={onOpenSettings}
          title={t('Secretary settings')}
          aria-label={t('Secretary settings')}
          className={ACTION_CLASS}
        >
          <Settings className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          data-enso="secretary-action"
          data-action="new"
          onClick={onNewConversation}
          title={t('New conversation')}
          aria-label={t('New conversation')}
          className={ACTION_CLASS}
        >
          <Plus className="h-3.5 w-3.5" />
        </button>
      </span>
      <button
        type="button"
        data-enso="secretary-fold-trailing"
        onClick={onToggleFold}
        aria-expanded={!folded}
        aria-label={foldLabel}
        title={foldLabel}
        className={cn(ACTION_CLASS, 'hidden [@media(hover:none)]:flex')}
      >
        <ChevronDown className={cn('h-3.5 w-3.5 transition-transform', folded && '-rotate-90')} />
      </button>
    </div>
  );
  return (
    <div
      data-slot="secretary-section"
      data-enso="secretary-section"
      data-secretary-id={secretaryId}
    >
      <ContextMenu>
        <ContextMenuTrigger render={row as React.ReactElement<Record<string, unknown>>} />
        <ContextMenuPopup className="min-w-40">
          <ContextMenuItem onClick={onNewConversation}>
            <Plus />
            {t('New conversation')}
          </ContextMenuItem>
          <ContextMenuItem onClick={onOpenSettings}>
            <Settings />
            {t('Secretary settings')}
          </ContextMenuItem>
          <ContextMenuItem onClick={onReset}>
            <RefreshCw />
            {t('Re-run setup')}
          </ContextMenuItem>
        </ContextMenuPopup>
      </ContextMenu>
      {!folded && <div className="flex flex-col">{children}</div>}
      {divider && (
        <div data-enso="secretary-divider" className="mx-2 mt-1 border-t border-border" />
      )}
    </div>
  );
}

/** 折叠侧栏的头像按钮：状态点同展开态头像，右下角数字先报等你，没有再报未读 */
export function SecretaryCollapsedButton({
  view,
  onClick,
  unread = 0,
  active = false,
  secretaryId,
}: {
  view: SecretarySectionView;
  onClick: () => void;
  unread?: number;
  /** 正在看这个秘书的会话 */
  active?: boolean;
  secretaryId?: string;
}) {
  const { t } = useI18n();
  const label = collapsedLabel(view, unread, t);
  return (
    <button
      type="button"
      data-enso="secretary-collapsed"
      data-secretary-id={secretaryId}
      data-active={active || undefined}
      aria-pressed={active}
      onClick={onClick}
      title={label}
      aria-label={label}
      className={cn(COLLAPSED_BUTTON_CLASS, active && COLLAPSED_ACTIVE_CLASS)}
    >
      <SecretaryAvatar
        name={view.name}
        color={view.color}
        image={view.image}
        needsYou={view.needsYou}
        running={view.running}
        size="xs"
      />
      <CollapsedCount needsYou={view.needsYou} unread={unread} />
    </button>
  );
}

const COLLAPSED_BUTTON_CLASS =
  'relative flex size-8 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-foreground/5 hover:text-foreground';
/** 与侧栏选中会话行同一底色 */
const COLLAPSED_ACTIVE_CLASS = 'bg-foreground/[0.075] text-foreground dark:bg-foreground/10';

function collapsedLabel(
  view: SecretarySectionView,
  unread: number,
  t: (key: string, params?: Record<string, string | number>) => string
): string {
  return [
    view.name,
    ...(view.needsYou > 0 ? [t('{{n}} waiting', { n: view.needsYou })] : []),
    ...(view.running > 0 ? [t('{{n}} running', { n: view.running })] : []),
    ...(unread > 0 ? [t('{{n}} unread', { n: unread })] : []),
  ].join(' · ');
}

function CollapsedCount({ needsYou, unread }: { needsYou: number; unread: number }) {
  const n = needsYou > 0 ? needsYou : unread;
  if (n === 0) return null;
  return (
    <span
      data-enso="secretary-collapsed-count"
      data-tone={needsYou > 0 ? 'warn' : 'unread'}
      className={cn(
        'pointer-events-none absolute right-0 bottom-0 min-w-3.5 rounded-full px-[3px] text-center font-medium text-[9px] leading-3.5 tabular-nums ring-1 ring-background',
        needsYou > 0 ? 'bg-warning text-warning-foreground' : 'bg-muted text-muted-foreground'
      )}
    >
      {n > 99 ? '99+' : n}
    </span>
  );
}

export interface CollapsedSecretaryEntry {
  id: string;
  view: SecretarySectionView;
  unread: number;
  active: boolean;
}

/** 不超过这个数全部平铺；超过时平铺前 LIMIT-1 个，其余收进「+N」 */
export const COLLAPSED_SECRETARY_LIMIT = 5;

/**
 * 折叠侧栏的秘书头像列：顺序同展开态列表。
 * 列本身可收缩滚动，窗口再矮也不挤掉下面的设置等入口。
 */
export function SecretaryCollapsedRail({
  entries,
  onOpen,
  limit = COLLAPSED_SECRETARY_LIMIT,
}: {
  entries: readonly CollapsedSecretaryEntry[];
  onOpen: (secretaryId: string) => void;
  limit?: number;
}) {
  const { t } = useI18n();
  const overflowing = entries.length > limit;
  const shown = overflowing ? entries.slice(0, limit - 1) : entries;
  const hidden = overflowing ? entries.slice(limit - 1) : [];
  const hiddenNeedsYou = hidden.reduce((sum, entry) => sum + entry.view.needsYou, 0);
  const hiddenUnread = hidden.reduce((sum, entry) => sum + entry.unread, 0);
  const hiddenActive = hidden.some((entry) => entry.active);
  return (
    <div
      data-enso="secretary-collapsed-rail"
      className="flex min-h-0 shrink flex-col items-center gap-1 overflow-y-auto [scrollbar-width:none]"
    >
      {shown.map((entry) => (
        <SecretaryCollapsedButton
          key={entry.id}
          secretaryId={entry.id}
          view={entry.view}
          unread={entry.unread}
          active={entry.active}
          onClick={() => onOpen(entry.id)}
        />
      ))}
      {overflowing && (
        <Menu>
          <MenuTrigger
            render={
              <button
                type="button"
                data-enso="secretary-collapsed-more"
                data-active={hiddenActive || undefined}
                aria-pressed={hiddenActive}
                title={t('All secretaries')}
                aria-label={t('All secretaries')}
                className={cn(
                  COLLAPSED_BUTTON_CLASS,
                  'text-[11px] font-medium tabular-nums',
                  hiddenActive && COLLAPSED_ACTIVE_CLASS
                )}
              />
            }
          >
            +{hidden.length}
            {(hiddenNeedsYou > 0 || hiddenUnread > 0) && (
              <span
                data-enso="secretary-collapsed-more-dot"
                data-tone={hiddenNeedsYou > 0 ? 'warn' : 'unread'}
                className={cn(
                  'absolute top-1 right-1 size-2 rounded-full ring-2 ring-background',
                  hiddenNeedsYou > 0 ? 'bg-warning' : 'bg-muted-foreground'
                )}
              />
            )}
          </MenuTrigger>
          <MenuPopup side="right" align="start" className="min-w-48">
            {entries.map((entry) => (
              <MenuItem
                key={entry.id}
                data-secretary-id={entry.id}
                data-active={entry.active || undefined}
                onClick={() => onOpen(entry.id)}
                className={cn(entry.active && 'bg-accent text-accent-foreground')}
              >
                <SecretaryAvatar
                  name={entry.view.name}
                  color={entry.view.color}
                  image={entry.view.image}
                  needsYou={entry.view.needsYou}
                  running={entry.view.running}
                  size="sm"
                />
                <span className="min-w-0 flex-1 truncate">{entry.view.name}</span>
                {(entry.view.needsYou > 0 || entry.unread > 0) && (
                  <span
                    className={cn(
                      'shrink-0 text-xs tabular-nums',
                      entry.view.needsYou > 0 ? 'text-warning' : 'text-muted-foreground'
                    )}
                  >
                    {entry.view.needsYou > 0
                      ? t('{{n}} waiting', { n: entry.view.needsYou })
                      : t('{{n}} unread', { n: entry.unread })}
                  </span>
                )}
              </MenuItem>
            ))}
          </MenuPopup>
        </Menu>
      )}
    </div>
  );
}
