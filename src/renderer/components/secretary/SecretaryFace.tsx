import { cn } from '@/lib/utils';

/** 秘书的脸：有图用图，否则颜色加首字。调用方传入受控 URL，不传磁盘路径。 */
export function SecretaryFace({
  name,
  color,
  image,
  className,
  enso,
}: {
  name: string;
  color?: string;
  image?: string;
  className?: string;
  enso?: string;
}) {
  const initial = [...name.trim()][0] ?? '·';
  if (image) {
    return (
      <img
        data-enso={enso}
        data-image="true"
        src={image}
        alt=""
        draggable={false}
        className={cn('object-cover', className)}
        style={color ? { backgroundColor: color } : undefined}
      />
    );
  }
  return (
    <span
      data-enso={enso}
      className={cn(
        'flex items-center justify-center font-semibold text-white',
        !color && 'bg-brand',
        className
      )}
      style={color ? { backgroundColor: color } : undefined}
    >
      {initial}
    </span>
  );
}
