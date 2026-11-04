import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { net } from '@platform';
import { sniffImage } from '@shared/bots/cardPng';
import {
  BOT_AVATAR_HOST,
  IMAGE_EXTENSIONS,
  isMediaPath,
  isVideoPath,
  LOCAL_IMAGE_SCHEME,
  localImageUrlToPath,
  mediaExtension,
  PLUGIN_ASSET_HOST,
  REMOTE_FETCH_HOST,
} from '@shared/localImage';
import { isBotId } from '@shared/types/bot';

let botAvatarResolver: (botId: string) => string | null = () => null;

export function setBotAvatarResolver(resolve: (botId: string) => string | null): void {
  botAvatarResolver = resolve;
}

let pluginAssetResolver: ((pluginId: string, rel: string) => string | null) | null = null;

/** 插件图片和字体的真实路径。返回 null 表示拒绝。 */
export function setPluginAssetResolver(
  resolve: ((pluginId: string, rel: string) => string | null) | null
): void {
  pluginAssetResolver = resolve;
}

/** botId → 该成员 avatar.png；非法 id / 无图返回 null */
export function botAvatarFile(botId: string): string | null {
  return isBotId(botId) ? botAvatarResolver(botId) : null;
}

/**
 * `local-image://` 特权协议：为渲染层提供背景图媒体能力。
 * - 本地图片/视频：白名单扩展名校验后直接读盘（视频支持 Range 分片）
 * - `local-image://remote-fetch/?url=...`：主进程 net.fetch 代理远程图片，
 *   绕开渲染层的 CSP/CORS/重定向限制
 */

const MIME_TYPES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  jfif: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  svg: 'image/svg+xml',
  avif: 'image/avif',
  mp4: 'video/mp4',
  webm: 'video/webm',
  ogg: 'video/ogg',
  ogv: 'video/ogg',
  mov: 'video/quicktime',
};

const FONT_TYPES: Record<string, string> = {
  woff2: 'font/woff2',
  woff: 'font/woff',
  ttf: 'font/ttf',
  otf: 'font/otf',
};

/** 远程桌面隧道复用同一套校验：浏览器里的 local-image 请求经隧道转到这里 */
export async function handleLocalImageRequest(
  rawUrl: string,
  rangeHeader: string | null
): Promise<Response> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return new Response('Bad URL', { status: 400 });
  }
  if (url.protocol !== `${LOCAL_IMAGE_SCHEME}:`) return new Response('Bad URL', { status: 400 });
  if (url.hostname === REMOTE_FETCH_HOST) {
    return proxyRemoteImage(url);
  }
  if (url.hostname === BOT_AVATAR_HOST) {
    return serveBotAvatar(decodeURIComponent(url.pathname.slice(1)));
  }
  if (url.hostname === PLUGIN_ASSET_HOST) return servePluginAsset(url);
  return serveLocalMedia(url, rangeHeader);
}

function pluginAssetType(ext: string): string | null {
  if ((IMAGE_EXTENSIONS as readonly string[]).includes(ext)) return MIME_TYPES[ext] ?? null;
  return FONT_TYPES[ext] ?? null;
}

function decodeSegment(raw: string): string | null {
  try {
    return decodeURIComponent(raw);
  } catch {
    return null;
  }
}

async function servePluginAsset(url: URL): Promise<Response> {
  const rawParts = url.pathname.split('/').filter((part) => part.length > 0);
  if (rawParts.length < 2) return new Response('Bad path', { status: 400 });
  const parts: string[] = [];
  for (const raw of rawParts) {
    const decoded = decodeSegment(raw);
    if (decoded === null) return new Response('Bad path', { status: 400 });
    parts.push(decoded);
  }
  const pluginId = parts[0] ?? '';
  const rel = parts.slice(1).join('/');
  const type = pluginAssetType(mediaExtension(rel));
  if (!type) return new Response('Forbidden', { status: 403 });
  let filePath: string | null;
  try {
    filePath = pluginAssetResolver?.(pluginId, rel) ?? null;
  } catch {
    return new Response('Not found', { status: 404 });
  }
  if (!filePath) return new Response('Not found', { status: 404 });
  try {
    const data = new Uint8Array(await readFile(filePath));
    // 字体跨源要 CORS。URL 带安装代号，可以长缓存。
    return new Response(data, {
      headers: {
        'Content-Type': type,
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'max-age=31536000',
      },
    });
  } catch {
    return new Response('Not found', { status: 404 });
  }
}

async function serveBotAvatar(botId: string): Promise<Response> {
  const file = botAvatarFile(botId);
  if (!file) return new Response('Not found', { status: 404 });
  try {
    const data = new Uint8Array(await readFile(file));
    const format = sniffImage(data);
    if (!format) return new Response('Forbidden', { status: 403 });
    // URL 带版本号，同一 URL 内容不变；CORS 供导出人物卡时 fetch 读字节
    return new Response(data, {
      headers: {
        'Content-Type': `image/${format}`,
        'Cache-Control': 'max-age=31536000',
        'Access-Control-Allow-Origin': '*',
      },
    });
  } catch {
    return new Response('Not found', { status: 404 });
  }
}

async function proxyRemoteImage(url: URL): Promise<Response> {
  const remote = url.searchParams.get('url');
  if (!remote || !/^https?:\/\//i.test(remote)) {
    return new Response('Bad request', { status: 400 });
  }
  try {
    const upstream = await net.fetch(remote, { redirect: 'follow' });
    const headers = new Headers();
    const contentType = upstream.headers.get('content-type');
    if (contentType) headers.set('Content-Type', contentType);
    headers.set('Access-Control-Allow-Origin', '*');
    // 同 URL 可缓存：预加载（new Image）与 CSS background 共享同一份字节；
    // 随机图刷新靠 URL 上的 _t nonce 区分，不靠禁缓存
    headers.set('Cache-Control', 'public, max-age=86400');
    return new Response(upstream.body, { status: upstream.status, headers });
  } catch {
    return new Response('Fetch failed', { status: 502 });
  }
}

async function serveLocalMedia(url: URL, rangeHeader: string | null): Promise<Response> {
  const filePath = localImageUrlToPath(url);
  if (!filePath) return new Response('Bad path', { status: 400 });
  if (!isMediaPath(filePath)) return new Response('Forbidden', { status: 403 });

  const mime = MIME_TYPES[mediaExtension(filePath)] ?? 'application/octet-stream';

  try {
    const stats = await stat(filePath);
    if (!stats.isFile()) return new Response('Not a file', { status: 400 });

    // 视频按 Range 分片流式返回，<video> 拖动进度依赖 206
    if (isVideoPath(filePath) && rangeHeader) {
      const match = /bytes=(\d+)-(\d*)/.exec(rangeHeader);
      if (match) {
        const start = Number(match[1]);
        const end = match[2] ? Math.min(Number(match[2]), stats.size - 1) : stats.size - 1;
        if (start <= end && start < stats.size) {
          const stream = createReadStream(filePath, { start, end });
          return new Response(Readable.toWeb(stream) as ReadableStream, {
            status: 206,
            headers: {
              'Content-Type': mime,
              'Content-Length': String(end - start + 1),
              'Content-Range': `bytes ${start}-${end}/${stats.size}`,
              'Accept-Ranges': 'bytes',
            },
          });
        }
        return new Response('Range Not Satisfiable', { status: 416 });
      }
    }

    if (isVideoPath(filePath)) {
      const stream = createReadStream(filePath);
      return new Response(Readable.toWeb(stream) as ReadableStream, {
        headers: {
          'Content-Type': mime,
          'Content-Length': String(stats.size),
          'Accept-Ranges': 'bytes',
        },
      });
    }

    const data = await readFile(filePath);
    return new Response(new Uint8Array(data), { headers: { 'Content-Type': mime } });
  } catch {
    return new Response('Not found', { status: 404 });
  }
}
