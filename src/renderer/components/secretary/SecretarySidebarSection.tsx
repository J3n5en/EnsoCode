import { ChevronDown, Plus, RefreshCw, Settings } from 'lucide-react';
import type * as React from 'react';
import {
  ContextMenu,
  ContextMenuItem,
  ContextMenuPopup,
  ContextMenuTrigger,
} from '@/components/ui/context-menu';
import { useI18n } from '@/i18n';
import { cn } from '@/lib/utils';
import { SecretaryAvatar } from './SecretaryAvatar';
import { type SecretarySectionView, SecretarySummary } from './secretaryView';

const ACTION_CLASS =
  'flex size-5 shrink-0 items-center justify-center rounded-[5px] text-muted-foreground transition-colors hover:bg-foreground/5 hover:text-foreground';

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
      className="group flex w-full items-center gap-2.5 rounded-[10px] px-2 py-1.5 transition-colors hover:bg-foreground/5"
    >
      {/* 折叠箭头在 hover 时顶掉头像：不占布局宽度，人物卡才和下面的会话行左对齐 */}
      <button
        type="button"
        data-enso="secretary-fold"
        onClick={onToggleFold}
        aria-expanded={!folded}
        aria-label={folded ? t('Expand') : t('Collapse')}
        title={folded ? t('Expand') : t('Collapse')}
        className="shrink-0 rounded-[9px]"
      >
        <span className={cn('block', folded ? 'hidden' : 'group-hover:hidden')}>
          <SecretaryAvatar
            name={view.name}
            color={view.color}
            image={view.image}
            needsYou={view.needsYou}
            running={view.running}
          />
        </span>
        <span
          className={cn(
            'size-7 items-center justify-center rounded-[9px] bg-muted text-muted-foreground',
            folded ? 'flex' : 'hidden group-hover:flex'
          )}
        >
          <ChevronDown className={cn('size-3.5', folded && '-rotate-90')} />
        </span>
      </button>
      <button
        type="button"
        data-enso="secretary-open"
        onClick={onOpen}
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
          <SecretarySummary view={view} />
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
      <div data-enso="secretary-divider" className="mx-2 mt-1 border-t border-border" />
    </div>
  );
}

/** 折叠侧栏时只留头像与状态点，点开最近的秘书会话 */
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
      className="flex size-8 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-foreground/5 hover:text-foreground"
    >
      <SecretaryAvatar
        name={view.name}
        color={view.color}
        image={view.image}
        needsYou={view.needsYou}
        running={view.running}
        size="xs"
      />
    </button>
  );
}
