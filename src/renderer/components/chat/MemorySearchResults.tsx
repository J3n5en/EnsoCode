import { useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { useI18n } from '@/i18n';
import { cn } from '@/lib/utils';
import type { MemoryCaptureView, MemorySearchHit } from './memorySearchHits';

export function MemorySearchResults({
  hits,
  defaultOpen = false,
}: {
  hits: MemorySearchHit[];
  defaultOpen?: boolean;
}) {
  const { t } = useI18n();
  if (hits.length === 0) {
    return <p className="px-3 py-2 text-xs text-muted-foreground">{t('No results')}</p>;
  }
  return (
    <ul className="divide-y divide-border/60">
      {hits.map((hit) => (
        <MemoryHitRow key={hit.id} hit={hit} defaultOpen={defaultOpen} />
      ))}
    </ul>
  );
}

/** memory_capture：写入的那条直接展开；未写入时说明原因并列出挡住它的相似记忆 */
export function MemoryCaptureResult({ view }: { view: MemoryCaptureView }) {
  const { t } = useI18n();
  const note = view.written
    ? view.deduplicated && t('Identical memory already exists, nothing new was written')
    : t('Similar memories already exist, nothing was written');
  return (
    <>
      {note && <p className="px-3 pt-2 text-xs text-muted-foreground">{note}</p>}
      {view.written ? (
        <MemorySearchResults hits={[view.memory]} defaultOpen />
      ) : (
        <MemorySearchResults hits={view.candidates} />
      )}
    </>
  );
}

function MemoryHitRow({ hit, defaultOpen }: { hit: MemorySearchHit; defaultOpen: boolean }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(defaultOpen);
  return (
    <li>
      <button
        type="button"
        aria-expanded={open}
        onClick={(event) => {
          // 在本条内拖选复制时不切换折叠
          const selection = window.getSelection();
          if (selection?.toString() && event.currentTarget.contains(selection.anchorNode)) return;
          setOpen((v) => !v);
        }}
        className="block w-full cursor-pointer px-3 py-2 text-left transition-colors hover:bg-muted/40"
      >
        <span className="flex min-w-0 items-center gap-1.5">
          <span
            className={cn(
              'min-w-0 flex-1 font-medium text-foreground text-xs',
              open ? 'break-words' : 'truncate'
            )}
          >
            {hit.title}
          </span>
          {hit.unitType && (
            <Badge variant="secondary" size="sm">
              {hit.unitType}
            </Badge>
          )}
          {hit.space && (
            <Badge variant="outline" size="sm">
              {t(hit.space === 'global' ? 'Global' : 'Project')}
            </Badge>
          )}
          {hit.relevance !== null && (
            <span
              className="shrink-0 font-mono text-[10px] text-muted-foreground/70 tabular-nums"
              title={t('Semantic similarity')}
            >
              {hit.relevance.toFixed(2)}
            </span>
          )}
        </span>
        <span
          className={cn(
            'mt-0.5 whitespace-pre-wrap break-words text-muted-foreground text-xs leading-relaxed',
            open ? 'block' : 'line-clamp-2'
          )}
        >
          {hit.content}
        </span>
      </button>
    </li>
  );
}
