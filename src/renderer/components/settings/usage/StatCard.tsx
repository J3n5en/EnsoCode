import { cn } from '@/lib/utils';

interface StatCardProps {
  label: string;
  value: string;
  /** 相对上期变化（'+86.4%' / 'new' / null） */
  delta: string | null;
  tone?: 'default' | 'success' | 'info' | 'muted';
}

const TONE_CLASS: Record<NonNullable<StatCardProps['tone']>, string> = {
  default: 'text-foreground',
  success: 'text-emerald-600 dark:text-emerald-400',
  info: 'text-sky-600 dark:text-sky-400',
  muted: 'text-muted-foreground',
};

/** 统计卡：标签 + 大号等宽数值 + 右上角 delta。delta 不着色——涨费用是坏事、涨 token 是中性，颜色反而误导。 */
export function StatCard({ label, value, delta, tone = 'default' }: StatCardProps) {
  return (
    <div className="rounded-lg border bg-card px-4 py-3">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-xs text-muted-foreground">{label}</span>
        {delta && (
          <span className="font-mono text-[11px] tabular-nums text-muted-foreground">{delta}</span>
        )}
      </div>
      <div className={cn('mt-1 font-mono text-2xl font-semibold tabular-nums', TONE_CLASS[tone])}>
        {value}
      </div>
    </div>
  );
}
