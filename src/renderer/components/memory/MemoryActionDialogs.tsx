import { UNIT_TYPES, type UnitType } from '@shared/memory/constants';
import type { MemoryDeletionImpact, MemoryDetail, MemoryEditPatch } from '@shared/memory/dto';
import { Pencil, Trash2 } from 'lucide-react';
import * as React from 'react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogTitle,
} from '@/components/ui/dialog';
import { HoverActions, rowFinalFocus } from '@/components/ui/hover-actions';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { useI18n } from '@/i18n';

/**
 * 记忆的手动编辑与永久删除：设置页记忆库和秘书面板共用。
 * 都走 memory.update / deletePreview / delete，索引同步与审计在 Main 完成。
 */

type Translate = (key: string, params?: Record<string, string>) => string;

export interface MemoryDraft {
  title: string;
  content: string;
  unitType: UnitType;
  /** 输入框原文，保存时再校验 */
  importance: string;
}

export function draftFromMemory(memory: MemoryDetail): MemoryDraft {
  return {
    title: memory.title,
    content: memory.content,
    unitType: memory.unitType,
    importance: String(memory.importance),
  };
}

/** 草稿转成提交给 Main 的补丁；不合法时给出提示文案的 key */
export function draftToPatch(draft: MemoryDraft): { patch: MemoryEditPatch } | { error: string } {
  if (!draft.content.trim()) return { error: 'Content cannot be empty.' };
  const importance = Number(draft.importance);
  if (draft.importance.trim() === '' || !(importance >= 0 && importance <= 1)) {
    return { error: 'Importance must be between 0 and 1.' };
  }
  return {
    patch: { title: draft.title, content: draft.content, unitType: draft.unitType, importance },
  };
}

function titleList(titles: string[]): string {
  const shown = titles.slice(0, 5).map((title) => `“${title}”`);
  return titles.length > 5 ? `${shown.join('、')}…` : shown.join('、');
}

/** 删除确认框里的影响说明，一条一句 */
export function deletionImpactLines(impact: MemoryDeletionImpact, t: Translate): string[] {
  const lines: string[] = [];
  const history = impact.deleted.filter((d) => d.role === 'history');
  if (history.length > 0) {
    lines.push(
      t('Also deletes {{count}} older versions it replaced: {{titles}}', {
        count: String(history.length),
        titles: titleList(history.map((d) => d.title)),
      })
    );
  }
  if (impact.bridges.length > 0) {
    lines.push(
      t(
        'The older and newer versions around it are linked directly, so the history stays continuous.'
      )
    );
  }
  if (impact.relations.length > 0) {
    lines.push(
      t('Removes the relation links to {{titles}}; those memories are kept.', {
        titles: titleList(impact.relations.map((r) => r.title)),
      })
    );
  }
  for (const crystal of impact.crystalsUpdated) {
    lines.push(
      t('Crystal {{title}} loses this source and keeps {{count}} sources.', {
        title: `“${crystal.title}”`,
        count: String(crystal.remaining),
      })
    );
  }
  for (const crystal of impact.crystalsDemoted) {
    lines.push(
      t(
        'Crystal {{title}} would be left with {{count}} sources, so it becomes a normal memory. Its content is kept.',
        { title: `“${crystal.title}”`, count: String(crystal.remaining) }
      )
    );
  }
  if (impact.releasedSources > 0) {
    lines.push(
      t('This is a crystal: its {{count}} source memories are kept, only the links are removed.', {
        count: String(impact.releasedSources),
      })
    );
  }
  if (lines.length === 0) lines.push(t('No other memories are affected.'));
  return lines;
}

/** 行内编辑 / 删除：不用先点开详情；悬停或键盘聚焦到这一行时浮在右侧蒙版上，平时不占位 */
export function MemoryRowActions({
  id,
  onEdit,
  onDelete,
  className,
}: {
  id: string;
  onEdit: (id: string) => void;
  onDelete: (id: string) => void;
  className?: string;
}) {
  const { t } = useI18n();
  return (
    <HoverActions className={className}>
      <Button
        variant="ghost"
        size="icon-xs"
        aria-label={t('Edit')}
        title={t('Edit')}
        data-memory-action="row-edit"
        className="text-muted-foreground hover:text-foreground"
        onClick={() => onEdit(id)}
      >
        <Pencil />
      </Button>
      <Button
        variant="ghost"
        size="icon-xs"
        aria-label={t('Delete permanently')}
        title={t('Delete permanently')}
        data-memory-action="row-delete"
        className="text-destructive/80 hover:bg-destructive/8 hover:text-destructive"
        onClick={() => onDelete(id)}
      >
        <Trash2 />
      </Button>
    </HoverActions>
  );
}

/** 编辑一条记忆：标题、正文、类型、重要度；打开时自己拉详情拿完整正文 */
export function MemoryEditDialog({
  memoryId,
  onClose,
  onSaved,
}: {
  memoryId: string | null;
  onClose: () => void;
  onSaved?: (id: string) => void;
}) {
  const { t } = useI18n();
  const [draft, setDraft] = React.useState<MemoryDraft | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  // 调用方常传内联函数，放进 ref，免得每次渲染都重拉详情、把草稿冲掉
  const onCloseRef = React.useRef(onClose);
  onCloseRef.current = onClose;

  React.useEffect(() => {
    setDraft(null);
    setError(null);
    if (!memoryId) return;
    let alive = true;
    void window.electronAPI.memory.detail(memoryId).then((detail) => {
      if (!alive) return;
      if (detail) setDraft(draftFromMemory(detail));
      else onCloseRef.current();
    });
    return () => {
      alive = false;
    };
  }, [memoryId]);

  const save = async () => {
    if (!memoryId || !draft) return;
    const parsed = draftToPatch(draft);
    if ('error' in parsed) return setError(t(parsed.error));
    setBusy(true);
    const result = await window.electronAPI.memory.update(memoryId, parsed.patch);
    setBusy(false);
    if (!result.ok) return setError(result.error ?? t('Could not save the memory.'));
    onClose();
    onSaved?.(memoryId);
  };

  return (
    <Dialog
      open={memoryId !== null && draft !== null}
      onOpenChange={(open) => !open && !busy && onClose()}
    >
      <DialogContent finalFocus={rowFinalFocus}>
        {draft && (
          <>
            <DialogHeader>
              <DialogTitle>{t('Edit memory')}</DialogTitle>
              <DialogDescription>
                {t('Search indexes are rebuilt from the new text right away.')}
              </DialogDescription>
            </DialogHeader>
            <DialogPanel className="space-y-3" data-memory-edit={memoryId ?? ''}>
              <label className="block space-y-1">
                <span className="text-muted-foreground text-xs">{t('Memory title')}</span>
                <Input
                  value={draft.title}
                  data-memory-field="title"
                  onChange={(event) => setDraft({ ...draft, title: event.target.value })}
                />
              </label>
              <label className="block space-y-1">
                <span className="text-muted-foreground text-xs">{t('Content')}</span>
                <Textarea
                  value={draft.content}
                  rows={6}
                  data-memory-field="content"
                  onChange={(event) => setDraft({ ...draft, content: event.target.value })}
                />
              </label>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1">
                  <span className="text-muted-foreground text-xs">{t('Type')}</span>
                  <Select
                    value={draft.unitType}
                    items={UNIT_TYPES.map((type) => ({ value: type, label: type }))}
                    onValueChange={(value) => {
                      const next = UNIT_TYPES.find((type) => type === value);
                      if (next) setDraft({ ...draft, unitType: next });
                    }}
                  >
                    <SelectTrigger size="sm" data-memory-field="unitType">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectPopup>
                      {UNIT_TYPES.map((type) => (
                        <SelectItem key={type} value={type}>
                          {type}
                        </SelectItem>
                      ))}
                    </SelectPopup>
                  </Select>
                </div>
                <label className="block space-y-1">
                  <span className="text-muted-foreground text-xs">{t('Importance (0–1)')}</span>
                  <Input
                    type="number"
                    min={0}
                    max={1}
                    step={0.05}
                    size="sm"
                    value={draft.importance}
                    data-memory-field="importance"
                    onChange={(event) => setDraft({ ...draft, importance: event.target.value })}
                  />
                </label>
              </div>
              {error && <p className="text-destructive text-xs">{error}</p>}
            </DialogPanel>
            <DialogFooter>
              <DialogClose render={<Button variant="outline" size="sm" disabled={busy} />}>
                {t('Cancel')}
              </DialogClose>
              <Button
                size="sm"
                disabled={busy}
                data-memory-action="save"
                onClick={() => void save()}
              >
                {t('Save')}
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

/** 永久删除：先拉影响预览，拿到之前确认按钮不可点；确认后才真正删除 */
export function MemoryDeleteDialog({
  ids,
  onClose,
  onDeleted,
}: {
  ids: readonly string[] | null;
  onClose: () => void;
  onDeleted?: (ids: readonly string[]) => void;
}) {
  const { t } = useI18n();
  // undefined = 影响说明还在加载；null = Main 找不到这些记忆
  const [impact, setImpact] = React.useState<MemoryDeletionImpact | null | undefined>(undefined);
  const [busy, setBusy] = React.useState(false);

  React.useEffect(() => {
    setImpact(undefined);
    if (!ids) return;
    let alive = true;
    void window.electronAPI.memory.deletePreview([...ids]).then((result) => {
      if (alive) setImpact(result);
    });
    return () => {
      alive = false;
    };
  }, [ids]);

  const confirm = async () => {
    if (!ids) return;
    setBusy(true);
    try {
      // 串行一次删一条：后面的若已作为前面那条的历史版本被删掉，Main 返回 not found，忽略即可
      for (const id of ids) await window.electronAPI.memory.delete(id);
    } finally {
      setBusy(false);
    }
    onClose();
    onDeleted?.(ids);
  };

  return (
    <Dialog open={ids !== null} onOpenChange={(open) => !open && !busy && onClose()}>
      <DialogContent finalFocus={rowFinalFocus}>
        <DialogHeader>
          <DialogTitle>
            {ids && ids.length > 1
              ? t('Delete {{count}} memories permanently?', { count: String(ids.length) })
              : t('Delete this memory permanently?')}
          </DialogTitle>
          <DialogDescription>
            {t(
              'This cannot be undone. Archiving keeps the memory out of search while preserving it.'
            )}
          </DialogDescription>
        </DialogHeader>
        <DialogPanel data-memory-delete-impact="">
          {impact === undefined ? (
            <p className="text-muted-foreground text-xs">{t('Checking what this affects…')}</p>
          ) : impact === null ? (
            <p className="text-muted-foreground text-xs">{t('Memory not found.')}</p>
          ) : (
            <ul className="list-disc space-y-1 ps-4 text-xs">
              {deletionImpactLines(impact, t).map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          )}
        </DialogPanel>
        <DialogFooter>
          <DialogClose render={<Button variant="outline" size="sm" disabled={busy} />}>
            {t('Cancel')}
          </DialogClose>
          <Button
            variant="destructive"
            size="sm"
            data-memory-action="confirm-delete"
            disabled={busy || !impact}
            onClick={() => void confirm()}
          >
            {t('Delete permanently')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
