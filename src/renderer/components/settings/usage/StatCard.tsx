import { cn } from '@/lib/utils';

interface StatCardProps {
  label: string;
  value: string;
  delta: string | null;
  tone?: 'default' | 'success' | 'info' | 'muted';
}

const TONE_CLASS: Record<NonNullable<StatCardProps['tone']>, string> = {
  default: 'text-foreground',
  success: 'text-emerald-600 dark:text-emerald-400',
  info: 'text-sky-600 dark:text-sky-400',
  muted: 'text-muted-foreground',
};

export function StatCard({ label, value, delta, tone = 'default' }: StatCardProps) {
  const positive = delta?.startsWith('+') || delta === 'new';
  return (
    <div className="rounded-lg border bg-card px-4 py-3">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-xs text-muted-foreground">{label}</span>
        {delta && (
          <span
            className={cn(
              'font-mono text-[11px] tabular-nums',
              positive ? 'text-muted-foreground' : 'text-muted-foreground/70'
            )}
          >
            {delta}
          </span>
        )}
      </div>
      <div className={cn('mt-1 font-mono text-2xl font-semibold tabular-nums', TONE_CLASS[tone])}>
        {value}
      </div>
    </div>
  );
}
