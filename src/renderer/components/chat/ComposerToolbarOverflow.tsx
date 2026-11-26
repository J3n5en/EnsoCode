import type { ComposerToolbarItemId } from '@shared/composerToolbar';
import { unpinComposerToolbarItem } from '@shared/composerToolbar';
import { Ellipsis, GripVertical, Pin, PinOff } from 'lucide-react';
import type { ReactNode } from 'react';
import { useRef, useState } from 'react';
import { Popover, PopoverPopup, PopoverTrigger } from '@/components/ui/popover';
import { useI18n } from '@/i18n';
import { cn } from '@/lib/utils';
import { useSettingsStore } from '@/stores/settings';

export const COMPOSER_TOOLBAR_ITEM_LABEL_KEYS: Record<ComposerToolbarItemId, string> = {
  preset: 'Preset',
  worktree: 'Worktree',
  'plan-mode': 'Plan',
  'approval-mode': 'Approval mode',
  model: 'Model',
  learn: 'Learn',
};

/**
 * composer 工具行的「更多」popover：列出全部按钮（功能与 pin 在外面时一致），
 * 每行可 pin/unpin，拖动左侧把手排序；状态持久化在 settings.composerToolbar。
 * pin 状态不决定按钮是否可用——popover 里始终渲染完整按钮。
 */
export function ComposerToolbarOverflow({
  renderItem,
}: {
  /** 按 id 渲染按钮本体；不可用的项（如子会话的预设锁、无 Plan 能力）返回 null，该行隐藏 */
  renderItem: (id: ComposerToolbarItemId) => ReactNode;
}) {
  const { t } = useI18n();
  const composerToolbar = useSettingsStore((state) => state.composerToolbar);
  const setComposerToolbar = useSettingsStore((state) => state.setComposerToolbar);
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [dropGap, setDropGap] = useState<number | null>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const rows = composerToolbar.order
    .map((id) => ({ id, node: renderItem(id) }))
    .filter((row) => row.node !== null && row.node !== undefined && row.node !== false);
  if (rows.length === 0) return null;

  const commitDrop = (targetIndex: number) => {
    if (dragIndex === null) return;
    const id = rows[dragIndex]?.id;
    if (id) {
      // 目标下标按删除拖动项之后的序列计算（与 StatusLineSettings 的 dropGap 语义一致）
      const order = composerToolbar.order.filter((entry) => entry !== id);
      const clamped = Math.max(0, Math.min(targetIndex, order.length));
      order.splice(clamped, 0, id);
      setComposerToolbar({ ...composerToolbar, order });
    }
    setDragIndex(null);
    setDropGap(null);
  };

  return (
    <Popover>
      <PopoverTrigger
        aria-label={t('More toolbar buttons')}
        title={t('More toolbar buttons')}
        className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground max-md:size-[32px]"
      >
        <Ellipsis className="h-3.5 w-3.5" />
      </PopoverTrigger>
      <PopoverPopup side="top" align="start" className="w-64 [&_[data-slot=popover-viewport]]:p-1">
        <div className="px-2 pb-1 pt-1.5 text-[11px] text-muted-foreground">
          {t('Pin buttons to the toolbar, drag to reorder')}
        </div>
        <div ref={listRef} data-composer-toolbar-overflow="">
          {rows.map((row, index) => (
            <div key={row.id}>
              {dragIndex !== null && dropGap === index && (
                <div className="mx-2 my-0.5 h-0.5 rounded-full bg-primary" />
              )}
              <div
                onDragOver={(event) => {
                  if (dragIndex === null) return;
                  event.preventDefault();
                  const rect = event.currentTarget.getBoundingClientRect();
                  const before = event.clientY < rect.top + rect.height / 2;
                  setDropGap(before ? index : index + 1);
                }}
                onDrop={(event) => {
                  event.preventDefault();
                  commitDrop(dropGap ?? index);
                }}
                className={cn(
                  'flex items-center gap-1 rounded-md px-1 py-0.5',
                  dragIndex === index && 'opacity-40'
                )}
              >
                <span
                  role="button"
                  tabIndex={-1}
                  draggable
                  onDragStart={(event) => {
                    event.dataTransfer.effectAllowed = 'move';
                    event.dataTransfer.setData('text/plain', row.id);
                    setDragIndex(index);
                  }}
                  onDragEnd={() => {
                    setDragIndex(null);
                    setDropGap(null);
                  }}
                  aria-label={t('Drag to reorder')}
                  className="shrink-0 cursor-grab text-muted-foreground/50 hover:text-foreground active:cursor-grabbing"
                >
                  <GripVertical className="h-3.5 w-3.5" />
                </span>
                <div className="flex min-w-0 flex-1 items-center [&_[data-slot=popover-trigger]]:w-full">
                  {row.node}
                </div>
                <button
                  type="button"
                  aria-label={
                    composerToolbar.pinned.includes(row.id)
                      ? t('Unpin from toolbar')
                      : t('Pin to toolbar')
                  }
                  title={
                    composerToolbar.pinned.includes(row.id)
                      ? t('Unpin from toolbar')
                      : t('Pin to toolbar')
                  }
                  data-pin-item={row.id}
                  data-pinned={composerToolbar.pinned.includes(row.id) ? 'true' : 'false'}
                  onClick={() =>
                    setComposerToolbar(
                      composerToolbar.pinned.includes(row.id)
                        ? unpinComposerToolbarItem(composerToolbar, row.id)
                        : {
                            order: composerToolbar.order,
                            pinned: [...composerToolbar.pinned, row.id],
                          }
                    )
                  }
                  className={cn(
                    'flex h-6 w-6 shrink-0 items-center justify-center rounded-md transition-colors hover:bg-accent',
                    composerToolbar.pinned.includes(row.id)
                      ? 'text-foreground'
                      : 'text-muted-foreground/50'
                  )}
                >
                  {composerToolbar.pinned.includes(row.id) ? (
                    <Pin className="h-3.5 w-3.5" />
                  ) : (
                    <PinOff className="h-3.5 w-3.5" />
                  )}
                </button>
              </div>
            </div>
          ))}
          {dragIndex !== null && dropGap === rows.length && (
            <div className="mx-2 my-0.5 h-0.5 rounded-full bg-primary" />
          )}
        </div>
      </PopoverPopup>
    </Popover>
  );
}
