import { useState } from 'react';
import { GeneratedAvatar } from '@/components/bots/GeneratedAvatar';
import { cn } from '@/lib/utils';

const DEFAULT_COLOR = '#7c5cff';

/**
 * 秘书的脸：有图用图，否则和 bot 一样按名字与头像色用 boring-avatars 生成。
 * 调用方传入受控 URL，不传磁盘路径。图片加载失败时回退到生成头像，换了地址再试。
 */
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
  const [failed, setFailed] = useState<string | null>(null);
  if (image && failed !== image) {
    return (
      <img
        data-enso={enso}
        data-image="true"
        src={image}
        alt=""
        draggable={false}
        onError={() => setFailed(image)}
        className={cn('object-cover', className)}
        style={color ? { backgroundColor: color } : undefined}
      />
    );
  }
  return (
    <span
      data-enso={enso}
      data-generated="true"
      className={cn('relative block shrink-0 overflow-hidden', className)}
    >
      <GeneratedAvatar name={name.trim() || 'secretary'} color={color ?? DEFAULT_COLOR} />
    </span>
  );
}
