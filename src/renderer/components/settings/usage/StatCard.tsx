import { PopDigits } from '@/components/ui/pop-digits';
import { cn } from '@/lib/utils';
import { SettingsPreview } from '../kit';

interface StatCardProps {
  label: string;
  value: string;
  /** 相对上期变化（'+86.4%' / 'new' / null） */
  delta: string | null;
  tone?: 'default' | 'success' | 'info' | 'muted';
}

const TONE_CLASS: Record<NonNullable<StatCardProps['tone']>, string> = {
  default: 'text-foreground',
  success: 'text-success',
  info: 'text-info',
  muted: 'text-muted-foreground',
};

/** 统计卡：标签 + 大号等宽数值 + 右上角 delta。delta 不着色——涨费用是坏事、涨 token 是中性，颜色反而误导。 */
export function StatCard({ label, value, delta, tone = 'default' }: StatCardProps) {
  return (
    <SettingsPreview className="min-w-0 overflow-hidden px-4 py-3">
      <div className="flex items-baseline justify-between gap-2">
        <span className="min-w-0 text-xs text-muted-foreground">{label}</span>
        {delta && (
          <span className="shrink-0 font-mono text-[11px] tabular-nums text-muted-foreground">
            {delta}
          </span>
        )}
      </div>
      <div
        className={cn(
          'mt-1 truncate font-mono text-xl font-semibold leading-tight tabular-nums sm:text-2xl',
          TONE_CLASS[tone]
        )}
        title={value}
      >
        <PopDigits value={value} />
      </div>
    </SettingsPreview>
  );
}
