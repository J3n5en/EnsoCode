import type { MemoryListItem } from '@shared/memory/dto';
import { Loader2, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { addToast } from '@/components/ui/toast';
import { useI18n } from '@/i18n';

/** 某个记忆空间（bot:<id> / chat:<id>）的条目列表，可逐条删除 */
export function MemorySpaceList({ spaceId, emptyText }: { spaceId: string; emptyText: string }) {
  const { t } = useI18n();
  const [items, setItems] = useState<MemoryListItem[] | null>(null);

  const load = useCallback(async () => {
    const result = await window.electronAPI.memory.list({ spaceId, limit: 100, offset: 0 });
    setItems(result.items);
  }, [spaceId]);

  useEffect(() => {
    setItems(null);
    void load();
    return window.electronAPI.memory.onChanged(() => void load());
  }, [load]);

  if (items === null) return <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />;
  if (items.length === 0) return <p className="text-muted-foreground text-xs">{emptyText}</p>;
  return (
    <div className="space-y-1.5">
      {items.map((item) => (
        <div
          key={item.id}
          className="group flex items-start gap-2 rounded-lg border bg-card px-2.5 py-2"
        >
          <div className="min-w-0 flex-1">
            <div className="truncate font-medium text-xs">{item.title}</div>
            <div className="line-clamp-3 text-muted-foreground text-xs">{item.contentSummary}</div>
          </div>
          <button
            type="button"
            title={t('Delete')}
            aria-label={t('Delete')}
            onClick={() =>
              void window.electronAPI.memory.delete(item.id).then((result) => {
                if (result.ok)
                  setItems((list) => list?.filter((entry) => entry.id !== item.id) ?? null);
                else addToast({ type: 'error', title: result.error ?? t('Delete failed') });
              })
            }
            className="shrink-0 rounded p-1 text-muted-foreground opacity-0 transition-opacity hover:bg-muted hover:text-destructive group-hover:opacity-100"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        </div>
      ))}
    </div>
  );
}
