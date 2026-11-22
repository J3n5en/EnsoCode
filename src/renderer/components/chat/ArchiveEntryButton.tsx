import { Archive } from 'lucide-react';
import { useI18n } from '@/i18n';
import { cn } from '@/lib/utils';

/** 侧栏的已归档入口：每个 tab 常驻；0 条时弱化但不隐藏，数字角标不改变按钮尺寸 */
export function ArchiveEntryButton({
  count,
  onClick,
  className,
}: {
  count: number;
  onClick: () => void;
  className?: string;
}) {
  const { t } = useI18n();
  const empty = count === 0;
  const label = `${t('Archived')} (${count})`;
  return (
    <button
      type="button"
      data-slot="archived-button"
      data-empty={empty || undefined}
      onClick={onClick}
      className={cn('relative', className, empty && 'opacity-55')}
      title={label}
      aria-label={label}
    >
      <Archive className="h-4 w-4" />
      {!empty && (
        <span
          data-slot="archived-count"
          className="absolute top-0.5 right-0 min-w-3.5 rounded-full bg-muted px-[3px] text-center font-medium text-[9px] text-muted-foreground leading-3.5 tabular-nums"
        >
          {count > 99 ? '99+' : count}
        </span>
      )}
    </button>
  );
}

/** 已归档弹窗顶部的范围切换 */
export function ArchiveScopeChip({
  label,
  selected,
  onClick,
}: {
  label: string;
  selected: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      data-slot="archive-scope-chip"
      data-selected={selected || undefined}
      onClick={onClick}
      className={cn(
        'max-w-48 truncate rounded-full border px-2.5 py-0.5 text-xs transition-colors',
        selected
          ? 'border-brand/40 bg-brand/10 text-foreground'
          : 'text-muted-foreground hover:bg-muted hover:text-foreground'
      )}
    >
      {label}
    </button>
  );
}
