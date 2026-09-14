import { cn } from '@/lib/utils';

/** number pop-in：数值变化时逐位弹入（key 重挂载即重放，末两位错峰）。仅用于低频更新的数值。 */
export function PopDigits({ value, className }: { value: string; className?: string }) {
  const chars = value.split('');
  return (
    <span key={value} className={cn('t-digit-group is-animating', className)}>
      {chars.map((ch, i) => (
        <span
          // biome-ignore lint/suspicious/noArrayIndexKey: 位置+字符做 key 是刻意的——同位同字符复用，其余重挂载以重放弹入
          key={`${i}:${ch}`}
          className="t-digit"
          data-stagger={i === chars.length - 2 ? '1' : i === chars.length - 1 ? '2' : undefined}
        >
          {ch}
        </span>
      ))}
    </span>
  );
}
