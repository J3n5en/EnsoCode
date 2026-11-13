import type { SecretaryState } from '@shared/types/secretary';
import { ChevronRight, Plus, RefreshCw, Settings } from 'lucide-react';
import type * as React from 'react';
import {
  ContextMenu,
  ContextMenuItem,
  ContextMenuPopup,
  ContextMenuTrigger,
} from '@/components/ui/context-menu';
import { useI18n } from '@/i18n';
import { cn } from '@/lib/utils';

const ACTION_CLASS =
  'flex size-5 shrink-0 items-center justify-center rounded-[5px] text-muted-foreground transition-colors hover:bg-foreground/5 hover:text-foreground';

export interface SecretarySectionView {
  name: string;
  /** 「需要你处理」总数，折叠侧栏时也带着 */
  needsYou: number;
  /** false = 未完成初次设置，点击进欢迎页 */
  configured: boolean;
  color?: string;
}

/** 秘书伪项目的展示状态；开关关掉时整块不出现 */
export function secretarySectionView(
  secretary: Pick<SecretaryState, 'enabled' | 'profile' | 'board'>,
  t: (key: string) => string
): SecretarySectionView | null {
  if (!secretary.enabled) return null;
  const profile = secretary.profile;
  return {
    name: profile?.name.trim() || t('Secretary'),
    needsYou: secretary.board.needsYou.length,
    configured: profile !== null,
    ...(profile ? { color: profile.avatar.color } : {}),
  };
}

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

function avatarInitial(name: string): string {
  return [...name.trim()][0] ?? '·';
}

function Avatar({ view }: { view: SecretarySectionView }) {
  return (
    <span
      data-enso="secretary-avatar"
      className={cn(
        'flex size-4 shrink-0 items-center justify-center rounded-full text-[10px] font-semibold text-white',
        !view.color && 'bg-brand'
      )}
      style={view.color ? { backgroundColor: view.color } : undefined}
    >
      {avatarInitial(view.name)}
    </span>
  );
}

function Badge({ count }: { count: number }) {
  if (count <= 0) return null;
  return (
    <span
      data-enso="secretary-badge"
      className="flex h-4 min-w-4 shrink-0 items-center justify-center rounded-full bg-warning/20 px-1 text-[0.7143rem] font-medium text-warning tabular-nums"
    >
      {count}
    </span>
  );
}

/**
 * 置顶伪项目行：外观与项目行一致，但只有 ＋ 与 ⚙，且不参与拖拽、分组与排序。
 * 会话行由侧栏传入，这里只管伪项目行与折叠。
 */
export function SecretarySidebarSection({
  view,
  folded,
  onToggleFold,
  onOpen,
  onNewConversation,
  onOpenSettings,
  onReset,
  children,
}: SecretarySectionActions & {
  view: SecretarySectionView;
  folded: boolean;
  children: React.ReactNode;
}) {
  const { t } = useI18n();
  const row = (
    <div
      data-enso="secretary-row"
      data-expanded={!folded || undefined}
      className="group flex h-8 w-full items-center gap-1 rounded-lg px-2 transition-colors hover:bg-foreground/5"
    >
      <button
        type="button"
        data-enso="secretary-fold"
        onClick={onToggleFold}
        aria-expanded={!folded}
        aria-label={folded ? t('Expand') : t('Collapse')}
        className="flex size-4 shrink-0 items-center justify-center text-subtle-foreground"
      >
        <ChevronRight
          className={cn('size-3.5 transition-transform duration-150', !folded && 'rotate-90')}
        />
      </button>
      <button
        type="button"
        data-enso="secretary-open"
        onClick={onOpen}
        title={view.name}
        className="flex min-w-0 flex-1 items-center gap-2 text-left"
      >
        <Avatar view={view} />
        <span className="min-w-0 flex-1 truncate text-[0.9286rem] font-medium text-foreground">
          {view.name}
        </span>
      </button>
      <Badge count={view.needsYou} />
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
    </div>
  );
  return (
    <div data-slot="secretary-section" data-enso="secretary-section">
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
      <div data-enso="secretary-divider" className="mx-2 mt-1 border-t border-dashed" />
    </div>
  );
}

/** 折叠侧栏时只留图标与角标，点开最近的秘书会话 */
export function SecretaryCollapsedButton({
  view,
  onClick,
}: {
  view: SecretarySectionView;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      data-enso="secretary-collapsed"
      onClick={onClick}
      title={view.name}
      aria-label={view.name}
      className="relative flex size-8 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-foreground/5 hover:text-foreground"
    >
      <Avatar view={view} />
      {view.needsYou > 0 && (
        <span className="absolute -top-0.5 -right-0.5">
          <Badge count={view.needsYou} />
        </span>
      )}
    </button>
  );
}
