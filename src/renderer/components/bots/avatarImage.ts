import { avatarPalette } from '@shared/bots/avatarPalette';
import { botAvatarUrl } from '@shared/localImage';
import type { BotProfile } from '@shared/types/bot';
import Avatar from 'boring-avatars';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { useBotsStore } from '@/stores/bots';
import { AVATAR_EDGE, dataUrlBytes, renderSquare } from './avatarRaster';

export {
  AVATAR_EDGE,
  coverSquare,
  dataUrlBytes,
  readDataUrl,
  renderSquare,
} from './avatarRaster';

export type AvatarBot = Pick<BotProfile, 'name' | 'avatar'> & { id?: string };

/** 有图片头像时的受控 URL（只按 botId 寻址，带版本号失效缓存） */
export const botAvatarSrc = (bot: AvatarBot): string | undefined =>
  bot.id && bot.avatar.image ? botAvatarUrl(bot.id, bot.avatar.image) : undefined;

/** 无图片头像时：与界面一致的生成头像，栅格化为 512 PNG */
export async function generatedAvatarPng(name: string, color: string): Promise<string> {
  const svg = renderToStaticMarkup(
    createElement(Avatar, {
      name,
      variant: 'beam',
      colors: avatarPalette(color),
      size: AVATAR_EDGE,
    })
  );
  const image = new Image();
  image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  await image.decode();
  return renderSquare(image, 0, 0, AVATAR_EDGE);
}

export function downloadBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  link.click();
  URL.revokeObjectURL(url);
}

/** 经 Main 写入 / 移除头像（只传 botId + PNG 字节），成功后更新 store */
export async function saveBotAvatar(botId: string, dataUrl: string | null): Promise<boolean> {
  const result = await window.electronAPI.bots.setAvatar(
    botId,
    dataUrl ? dataUrlBytes(dataUrl) : null
  );
  if (result.ok) useBotsStore.getState().upsertBot(result.bot);
  return result.ok;
}
