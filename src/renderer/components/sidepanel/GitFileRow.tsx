import type { GitFile } from '@shared/types/git';
import { FileText } from 'lucide-react';
import type { ReactNode } from 'react';
import { useI18n } from '@/i18n';
import { cn } from '@/lib/utils';

const STATUS = {
  added: { label: 'A', color: 'text-success' },
  modified: { label: 'M', color: 'text-info' },
  deleted: { label: 'D', color: 'text-destructive' },
  untracked: { label: '?', color: 'text-success' },
  conflicted: { label: '!', color: 'text-warning' },
} as const;

export function GitFileRow({
  file,
  selected,
  onSelect,
  actions,
  showDirectory = true,
}: {
  file: GitFile;
  selected: boolean;
  onSelect: () => void;
  actions?: ReactNode;
  showDirectory?: boolean;
}) {
  const { t } = useI18n();
  const separator = file.path.lastIndexOf('/');
  const name = file.path.slice(separator + 1);
  const directory = file.path.slice(0, Math.max(0, separator));
  const status = STATUS[file.status];

  return (
    <div
      className={cn(
        'group flex min-w-0 items-center rounded-md pr-1 hover:bg-muted/50',
        selected && 'bg-brand/10 dark:bg-brand/15'
      )}
    >
      <button
        type="button"
        className="flex min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring"
        title={file.path}
        aria-pressed={selected}
        onClick={onSelect}
      >
        <FileText aria-hidden="true" className={cn('size-3.5 shrink-0', status.color)} />
        <span className={cn('truncate', !showDirectory && 'flex-1')}>{name}</span>
        {showDirectory && (
          <span className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground">
            {directory}
          </span>
        )}
        <span
          className={cn('shrink-0 font-mono text-[11px]', status.color)}
          title={t(file.status)}
        >
          <span aria-hidden="true">{status.label}</span>
          <span className="sr-only">{t(file.status)}</span>
        </span>
      </button>
      {actions && (
        <div className="flex shrink-0 items-center opacity-0 group-focus-within:opacity-100 group-hover:opacity-100 [@media(hover:none)]:opacity-100">
          {actions}
        </div>
      )}
    </div>
  );
}
