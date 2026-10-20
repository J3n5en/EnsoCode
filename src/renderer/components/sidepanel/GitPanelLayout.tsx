import { ChevronDown } from 'lucide-react';
import { type ReactNode, useId, useState } from 'react';
import { useI18n } from '@/i18n';
import { cn } from '@/lib/utils';

export function GitPanelLayout({
  title,
  hasSelection,
  navigation,
  actions,
  children,
}: {
  title: string;
  hasSelection: boolean;
  navigation: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
}) {
  const { t } = useI18n();
  const id = useId();
  const [open, setOpen] = useState(true);
  const expanded = !hasSelection || open;

  return (
    <div className="@container/git flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden @min-[720px]/git:flex-row">
        <div
          className={cn(
            'flex min-h-0 min-w-0 flex-col overflow-hidden border-b @min-[720px]/git:h-full @min-[720px]/git:max-h-none @min-[720px]/git:flex-none @min-[720px]/git:border-r @min-[720px]/git:border-b-0',
            expanded
              ? 'flex-1 @min-[720px]/git:w-[280px]'
              : 'shrink-0 @min-[720px]/git:w-8',
            expanded && hasSelection && 'max-h-[45%] basis-[45%] shrink-0'
          )}
        >
          <div className="flex shrink-0 items-center">
            <button
              type="button"
              className="flex min-h-7 min-w-0 flex-1 items-center gap-1.5 px-2 py-1 text-left text-[11px] font-medium text-muted-foreground hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring"
              aria-expanded={expanded}
              aria-controls={id}
              disabled={!hasSelection}
              title={t(expanded ? 'Collapse list' : 'Expand list')}
              onClick={() => setOpen(!expanded)}
            >
              <ChevronDown className={cn('size-3.5 shrink-0', !expanded && '-rotate-90')} />
              <span className={cn('truncate', !expanded && '@min-[720px]/git:hidden')}>
                {title}
              </span>
            </button>
            {expanded && actions && <div className="mr-1 flex shrink-0 items-center">{actions}</div>}
          </div>
          <div
            id={id}
            className={cn('flex min-h-0 flex-1 flex-col overflow-hidden', !expanded && 'hidden')}
          >
            {navigation}
          </div>
        </div>
        <div
          className={cn(
            'min-h-0 min-w-0 flex-1 flex-col overflow-hidden @min-[720px]/git:flex',
            hasSelection ? 'flex' : 'hidden'
          )}
        >
          {children}
        </div>
      </div>
    </div>
  );
}
