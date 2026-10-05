import type { PairBotMember } from '@enso/pair';
import { avatarPalette } from '@shared/bots/avatarPalette';
import Avatar from 'boring-avatars';
import { cn } from '@/lib/utils';

/** 头像：按名字与成员色生成；运行中加脉冲环 */
export function BotAvatar({
  bot,
  size = 'md',
  busy,
}: {
  bot: Pick<PairBotMember, 'name' | 'avatarColor'> | undefined;
  size?: 'sm' | 'md';
  busy?: boolean;
}) {
  return (
    <span
      aria-hidden
      className={cn(
        'flex shrink-0 overflow-hidden rounded-full bg-muted',
        size === 'sm' ? 'h-7 w-7' : 'h-9 w-9',
        busy && 'ring-2 ring-brand/60 ring-offset-1 ring-offset-background animate-pulse'
      )}
    >
      {bot && (
        <Avatar
          name={bot.name}
          variant="beam"
          colors={avatarPalette(bot.avatarColor)}
          size="100%"
        />
      )}
    </span>
  );
}
