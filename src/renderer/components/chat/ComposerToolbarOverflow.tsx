import {
  COMPOSER_TOOLBAR_MAX_SPACERS,
  type ComposerToolbarItemId,
  type ComposerToolbarSpacerKey,
  insertComposerToolbarSpacer,
  isSpacerKey,
  removeComposerToolbarSpacer,
  unpinComposerToolbarItem,
} from '@shared/composerToolbar';
import { Ellipsis, GripVertical, Pencil, Pin, PinOff, Plus, X } from 'lucide-react';
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
  'add-image': 'Add image',
};

type OverflowRow =
  | { kind: 'item'; id: ComposerToolbarItemId; node: ReactNode }
  | { kind: 'spacer'; id: ComposerToolbarSpacerKey };

const iconButtonClass =
  'flex h-6 w-6 shrink-0 items-center justify-center rounded-md transition-colors hover:bg-accent disabled:opacity-40';

/**
 * composer 工具行的「更多」popover：列出全部按钮（功能与 pin 在外面时一致），
 * 每行可 pin/unpin，拖动左侧把手排序。编辑模式可插入或删除弹性空白。
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
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);

  const rows: OverflowRow[] = [];
  for (const entry of composerToolbar.order) {
    if (isSpacerKey(entry)) {
      rows.push({ kind: 'spacer', id: entry });
      continue;
    }
    const node = renderItem(entry);
    if (node === null || node === undefined || node === false) continue;
    rows.push({ kind: 'item', id: entry, node });
  }
  if (rows.length === 0) return null;

  const canInsertSpacer =
    composerToolbar.order.filter(isSpacerKey).length < COMPOSER_TOOLBAR_MAX_SPACERS;

  const commitDrop = (targetIndex: number) => {
    if (dragIndex === null) return;
    const id = rows[dragIndex]?.id;
    if (id) {
      // dropGap 是可见行下标。隐藏按钮会让它和 order 下标错位，所以按 entry key 重建。
      const order = composerToolbar.order.filter((entry) => entry !== id);
      const clamped = Math.max(0, Math.min(targetIndex, order.length));
      order.splice(clamped, 0, id);
      setComposerToolbar({ ...composerToolbar, order });
    }
    setDragIndex(null);
    setDropGap(null);
  };

  const insertAfter = (id: OverflowRow['id']) => {
    const at = composerToolbar.order.indexOf(id);
    if (at === -1) return;
    setComposerToolbar(insertComposerToolbarSpacer(composerToolbar, at + 1));
  };

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) {
          setEditing(false);
          setDragIndex(null);
          setDropGap(null);
        }
      }}
    >
      <PopoverTrigger
        aria-label={t('More toolbar buttons')}
        title={t('More toolbar buttons')}
        className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground max-md:size-[32px]"
      >
        <Ellipsis className="h-3.5 w-3.5" />
      </PopoverTrigger>
      <PopoverPopup side="top" align="start" className="w-64 [&_[data-slot=popover-viewport]]:p-1">
        <div className="px-2 pb-1 pt-1.5 text-[11px] text-muted-foreground">
          {editing
            ? t('Edit mode: drag to reorder, insert or remove spacers')
            : t('Pin buttons to the toolbar, drag to reorder')}
        </div>
        <div ref={listRef} data-composer-toolbar-overflow="">
          {rows.map((row, index) => (
            <div key={row.id}>
              {dragIndex !== null && dropGap === index && (
                <div className="mx-2 my-0.5 h-0.5 rounded-full bg-primary" />
              )}
              {row.kind === 'spacer' && !editing ? (
                <div className="flex h-5 items-center" aria-hidden>
                  <div className="mx-2 w-full border-t border-dashed" />
                </div>
              ) : (
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
                    {row.kind === 'spacer' ? (
                      <div className="mx-2 flex h-5 min-w-0 flex-1 items-center justify-center rounded border border-dashed border-muted-foreground/40 text-[11px] text-muted-foreground">
                        {t('Flexible space')}
                      </div>
                    ) : (
                      row.node
                    )}
                  </div>
                  {editing && row.kind === 'item' && (
                    <button
                      type="button"
                      aria-label={t('Insert flexible space')}
                      title={t('Insert flexible space')}
                      disabled={!canInsertSpacer}
                      onClick={() => insertAfter(row.id)}
                      className={cn(iconButtonClass, 'text-muted-foreground')}
                    >
                      <Plus className="h-3.5 w-3.5" />
                    </button>
                  )}
                  {row.kind === 'item' ? (
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
                        iconButtonClass,
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
                  ) : (
                    <button
                      type="button"
                      aria-label={t('Remove flexible space')}
                      title={t('Remove flexible space')}
                      onClick={() =>
                        setComposerToolbar(removeComposerToolbarSpacer(composerToolbar, row.id))
                      }
                      className={cn(iconButtonClass, 'text-muted-foreground')}
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  )}
                </div>
              )}
            </div>
          ))}
          {dragIndex !== null && dropGap === rows.length && (
            <div className="mx-2 my-0.5 h-0.5 rounded-full bg-primary" />
          )}
        </div>
        <div className="flex justify-end px-1 pt-1 pb-0.5">
          <button
            type="button"
            onClick={() => setEditing((value) => !value)}
            className="flex h-6 items-center gap-1 rounded-md px-1.5 text-[11px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            <Pencil className="h-3 w-3" />
            {editing ? t('Done editing') : t('Edit toolbar layout')}
          </button>
        </div>
      </PopoverPopup>
    </Popover>
  );
}
