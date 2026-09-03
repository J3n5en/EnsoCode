import { formatCost, formatTokens } from '@shared/usage/format';
import type { UsageDailyPoint } from '@shared/usage/types';
import * as React from 'react';
import { useI18n } from '@/i18n';
import { cn } from '@/lib/utils';

type Metric = 'tokens' | 'cost';

const W = 640;
const H = 180;
const PAD_TOP = 8;
const PAD_BOTTOM = 18;
const GAP_RATIO = 0.3;

function dayLabel(day: string): string {
  const [, m, d] = day.split('-');
  return `${Number(m)}/${Number(d)}`;
}

/** 每日趋势：Token 模式堆叠 输出/输入/缓存 三段；费用模式单柱。纯 SVG，随容器宽度缩放。 */
export function DailyTrendChart({ daily }: { daily: UsageDailyPoint[] }) {
  const { t } = useI18n();
  const [metric, setMetric] = React.useState<Metric>('tokens');
  const [hover, setHover] = React.useState<number | null>(null);

  const values = daily.map((p) =>
    metric === 'tokens' ? p.input + p.output + p.cache : (p.cost ?? 0)
  );
  const max = Math.max(0, ...values);
  const n = Math.max(1, daily.length);
  const slot = W / n;
  const barW = slot * (1 - GAP_RATIO);
  const plotH = H - PAD_TOP - PAD_BOTTOM;
  const scale = (v: number) => (max > 0 ? (v / max) * plotH : 0);

  // 横轴标签最多 ~12 个，避免 90 天时挤成一团
  const labelEvery = Math.max(1, Math.ceil(n / 12));
  const hovered = hover !== null ? daily[hover] : null;

  return (
    <div className="rounded-lg border bg-card p-4">
      <div className="mb-3 flex items-center justify-between gap-2">
        <span className="text-sm font-medium">{t('Daily trend')}</span>
        <div className="flex items-center gap-3">
          {metric === 'tokens' && (
            <div className="flex items-center gap-3 text-[11px] text-muted-foreground">
              <Legend className="bg-foreground" label={t('Output')} />
              <Legend className="bg-foreground/45" label={t('Input')} />
              <Legend className="bg-foreground/15" label={t('Cache')} />
            </div>
          )}
          <MetricToggle value={metric} onChange={setMetric} />
        </div>
      </div>
      <div className="relative">
        <div className="pointer-events-none absolute left-0 top-0 font-mono text-[10px] text-muted-foreground">
          {metric === 'tokens' ? formatTokens(max) : formatCost(max)}
        </div>
        {hovered && (
          <div className="pointer-events-none absolute right-0 top-0 rounded bg-popover px-2 py-1 font-mono text-[11px] text-popover-foreground shadow-sm ring-1 ring-border">
            {hovered.day} ·{' '}
            {metric === 'tokens' ? formatTokens(values[hover ?? 0] ?? 0) : formatCost(hovered.cost)}
          </div>
        )}
        <svg
          viewBox={`0 0 ${W} ${H}`}
          className="mt-4 block h-[180px] w-full"
          role="img"
          aria-label={t('Daily trend')}
          onMouseLeave={() => setHover(null)}
        >
          {daily.map((p, i) => {
            const x = i * slot + (slot - barW) / 2;
            const base = H - PAD_BOTTOM;
            const segments =
              metric === 'tokens'
                ? [
                    { v: p.cache, cls: 'fill-foreground/15' },
                    { v: p.input, cls: 'fill-foreground/45' },
                    { v: p.output, cls: 'fill-foreground' },
                  ]
                : [{ v: p.cost ?? 0, cls: 'fill-emerald-500' }];
            let y = base;
            return (
              <g key={p.day} onMouseEnter={() => setHover(i)}>
                <rect x={x} y={PAD_TOP} width={barW} height={plotH} className="fill-transparent" />
                {segments.map((s) => {
                  const h = scale(s.v);
                  y -= h;
                  return (
                    <rect
                      key={s.cls}
                      x={x}
                      y={y}
                      width={barW}
                      height={h}
                      rx={1}
                      className={cn(s.cls, hover === i && 'opacity-80')}
                    />
                  );
                })}
                {i % labelEvery === 0 && (
                  <text
                    x={x + barW / 2}
                    y={H - 4}
                    textAnchor="middle"
                    className="fill-muted-foreground font-mono text-[10px]"
                  >
                    {dayLabel(p.day)}
                  </text>
                )}
              </g>
            );
          })}
        </svg>
      </div>
    </div>
  );
}

function Legend({ className, label }: { className: string; label: string }) {
  return (
    <span className="flex items-center gap-1">
      <span className={cn('inline-block h-2.5 w-2.5 rounded-sm', className)} />
      {label}
    </span>
  );
}

export function MetricToggle({
  value,
  onChange,
}: {
  value: Metric;
  onChange: (m: Metric) => void;
}) {
  const { t } = useI18n();
  const items: Array<{ id: Metric; label: string }> = [
    { id: 'tokens', label: t('Token') },
    { id: 'cost', label: t('Cost') },
  ];
  return (
    <div className="flex rounded-md bg-muted p-0.5">
      {items.map((item) => (
        <button
          key={item.id}
          type="button"
          onClick={() => onChange(item.id)}
          className={cn(
            'rounded px-2 py-0.5 text-[11px] transition-colors',
            value === item.id
              ? 'bg-background text-foreground shadow-sm'
              : 'text-muted-foreground hover:text-foreground'
          )}
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}
