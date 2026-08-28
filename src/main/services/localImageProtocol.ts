import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { Readable } from 'node:stream';
import {
  isMediaPath,
  isVideoPath,
  LOCAL_IMAGE_SCHEME,
  localImageUrlToPath,
  mediaExtension,
  REMOTE_FETCH_HOST,
} from '@shared/localImage';
import { net, protocol } from 'electron';

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

/** 必须在 app ready 之前调用（Electron 限制） */
export function registerLocalImageSchemePrivileges(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: LOCAL_IMAGE_SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        corsEnabled: true,
        bypassCSP: true,
        stream: true,
      },
    },
  ]);
}

/** 在 app ready 之后调用 */
export function registerLocalImageProtocolHandler(): void {
  protocol.handle(LOCAL_IMAGE_SCHEME, async (request) => {
    let url: URL;
    try {
      url = new URL(request.url);
    } catch {
      return new Response('Bad URL', { status: 400 });
    }

    if (url.hostname === REMOTE_FETCH_HOST) {
      return proxyRemoteImage(url);
    }
    return serveLocalMedia(url, request.headers.get('range'));
  });
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
