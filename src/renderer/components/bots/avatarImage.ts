import { avatarPalette } from '@shared/bots/avatarPalette';
import { botAvatarUrl } from '@shared/localImage';
import type { BotProfile } from '@shared/types/bot';
import Avatar from 'boring-avatars';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { useBotsStore } from '@/stores/bots';

export const AVATAR_EDGE = 512;

export type AvatarBot = Pick<BotProfile, 'name' | 'avatar'> & { id?: string };

/** 有图片头像时的受控 URL（只按 botId 寻址，带版本号失效缓存） */
export const botAvatarSrc = (bot: AvatarBot): string | undefined =>
  bot.id && bot.avatar.image ? botAvatarUrl(bot.id, bot.avatar.image) : undefined;

export const dataUrlBytes = (url: string): Uint8Array =>
  Uint8Array.from(atob(url.slice(url.indexOf(',') + 1)), (char) => char.charCodeAt(0));

export function readDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

function canvas(): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const el = document.createElement('canvas');
  el.width = AVATAR_EDGE;
  el.height = AVATAR_EDGE;
  const ctx = el.getContext('2d');
  if (!ctx) throw new Error('canvas unavailable');
  return [el, ctx];
}

/** 源图正方形区域 → 512×512 PNG data URL */
export function renderSquare(
  image: CanvasImageSource,
  sx: number,
  sy: number,
  side: number
): string {
  const [el, ctx] = canvas();
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(image, sx, sy, side, side, 0, 0, AVATAR_EDGE, AVATAR_EDGE);
  return el.toDataURL('image/png');
}

/** 整图居中裁成正方形（人物卡导入、导出时重绘） */
export async function coverSquare(blob: Blob): Promise<string> {
  const bitmap = await createImageBitmap(blob);
  const side = Math.min(bitmap.width, bitmap.height);
  try {
    return renderSquare(bitmap, (bitmap.width - side) / 2, (bitmap.height - side) / 2, side);
  } finally {
    bitmap.close();
  }
}

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
