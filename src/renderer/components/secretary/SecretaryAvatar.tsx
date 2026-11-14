import { cn } from '@/lib/utils';

const SIZES = {
  xs: 'size-6 rounded-[8px] text-[11.5px]',
  sm: 'size-[22px] rounded-[7px] text-[11.5px]',
  md: 'size-7 rounded-[9px] text-[13px]',
} as const;

/**
 * 秘书头像：圆角方块 + 首字，右上角状态点。
 * 有等你先用警告色，其次看在跑，都没有就不占位。
 */
export function SecretaryAvatar({
  name,
  color,
  needsYou,
  running,
  size = 'md',
}: {
  name: string;
  color?: string;
  needsYou: number;
  running: number;
  size?: keyof typeof SIZES;
}) {
  const tone = needsYou > 0 ? 'warn' : running > 0 ? 'run' : null;
  return (
    <span
      data-enso="secretary-avatar"
      className={cn(
        'relative flex shrink-0 items-center justify-center font-semibold text-white',
        SIZES[size],
        !color && 'bg-brand'
      )}
      style={color ? { backgroundColor: color } : undefined}
    >
      {[...name.trim()][0] ?? '·'}
      {tone && (
        <span
          data-enso="secretary-pip"
          data-tone={tone}
          className={cn(
            'absolute -top-1 -right-1 size-2.5 rounded-full border-2 border-background',
            tone === 'warn' ? 'bg-warning' : 'bg-success'
          )}
        />
      )}
    </span>
  );
}
