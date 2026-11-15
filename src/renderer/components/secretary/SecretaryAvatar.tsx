import { cn } from '@/lib/utils';
import { SecretaryFace } from './SecretaryFace';

const SIZES = {
  xs: 'size-6 rounded-[8px] text-[11.5px]',
  sm: 'size-[22px] rounded-[7px] text-[11.5px]',
  md: 'size-7 rounded-[9px] text-[13px]',
  lg: 'size-11 rounded-[13px] text-base',
} as const;

/**
 * 秘书头像：圆角方块。有图片时铺满，否则颜色加首字。右上角状态点。
 * 有等你先用警告色，其次看在跑，都没有就不占位。
 */
export function SecretaryAvatar({
  name,
  color,
  image,
  needsYou,
  running,
  size = 'md',
  enso = 'secretary-avatar',
}: {
  name: string;
  color?: string;
  image?: string;
  needsYou: number;
  running: number;
  size?: keyof typeof SIZES;
  enso?: string;
}) {
  const tone = needsYou > 0 ? 'warn' : running > 0 ? 'run' : null;
  return (
    <span
      data-enso={enso}
      data-image={image ? 'true' : undefined}
      className={cn('relative flex shrink-0', SIZES[size])}
    >
      <SecretaryFace
        name={name}
        color={color}
        image={image}
        enso={`${enso}-face`}
        className="size-full overflow-hidden rounded-[inherit]"
      />
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
