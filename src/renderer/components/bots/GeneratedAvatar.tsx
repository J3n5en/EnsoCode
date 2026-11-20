import { avatarPalette } from '@shared/bots/avatarPalette';
import Avatar from 'boring-avatars';

/** 按名字与主色生成 boring-avatars 头像；bot 与秘书共用同一套参数。父元素需 relative。 */
export function GeneratedAvatar({ name, color }: { name: string; color: string }) {
  return (
    <Avatar
      name={name}
      variant="beam"
      colors={avatarPalette(color)}
      size="100%"
      className="absolute inset-0 h-full w-full"
    />
  );
}
