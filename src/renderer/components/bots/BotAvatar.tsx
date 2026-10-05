import { avatarPalette } from '@shared/bots/avatarPalette';
import Avatar from 'boring-avatars';
import { useState } from 'react';
import { cn } from '@/lib/utils';
import type { Presence } from '@/stores/bots/presence';
import { type AvatarBot, botAvatarSrc } from './avatarImage';
import { PresenceMark } from './PresenceMark';

const SIZES = {
  xs: 'h-5 w-5 text-[9px]',
  sm: 'h-6 w-6 text-[11px]',
  md: 'h-8 w-8 text-[13px]',
  lg: 'h-16 w-16 text-2xl',
} as const;

/** 成员头像：有图显示图片（加载失败回落），否则按名字与成员色生成 boring-avatars；busy 时右下角呼吸点，presence 时右下角状态角标 */
export function BotAvatar({
  bot,
  src: override,
  size = 'md',
  busy = false,
  presence,
  className,
}: {
  bot: AvatarBot | undefined;
  /** 未保存的预览图（data URL），优先于档案图片 */
  src?: string;
  size?: keyof typeof SIZES;
  busy?: boolean;
  presence?: Presence;
  className?: string;
}) {
  const src = override ?? (bot ? botAvatarSrc(bot) : undefined);
  const [failed, setFailed] = useState<string | null>(null);
  return (
    <span
      className={cn(
        'relative grid shrink-0 select-none place-items-center rounded-full',
        !bot && 'bg-muted',
        SIZES[size],
        className
      )}
    >
      {src && failed !== src ? (
        <img
          src={src}
          alt=""
          draggable={false}
          onError={() => setFailed(src)}
          className="absolute inset-0 h-full w-full rounded-full object-cover"
        />
      ) : bot ? (
        <GeneratedAvatar name={bot.name} color={bot.avatar.color} />
      ) : null}
      {busy && (
        <span className="-right-px -bottom-px absolute h-2.5 w-2.5 animate-pulse rounded-full border-2 border-background bg-success" />
      )}
      {presence && (
        <PresenceMark
          state={presence}
          className="-right-1 -bottom-1 absolute box-content border-2 border-background"
        />
      )}
    </span>
  );
}

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

/** 群头像：最多三位成员叠放 */
export function GroupAvatar({
  bots,
  busy = false,
}: {
  bots: (AvatarBot | undefined)[];
  busy?: boolean;
}) {
  const shown = bots.slice(0, 3);
  const positions = ['left-0 top-0', 'right-0 top-1', 'left-1.5 bottom-0'];
  return (
    <span className="relative h-8 w-8 shrink-0">
      {shown.map((bot, index) => (
        <BotAvatar
          // biome-ignore lint/suspicious/noArrayIndexKey: 位置即身份
          key={index}
          bot={bot}
          size="xs"
          className={cn('absolute border-2 border-background', positions[index])}
        />
      ))}
      {busy && (
        <span className="-right-px -bottom-px absolute h-2.5 w-2.5 animate-pulse rounded-full border-2 border-background bg-success" />
      )}
    </span>
  );
}
