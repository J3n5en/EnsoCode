/**
 * 背景图媒体文件的共享约定：
 * - `local-image://` 特权协议 URL 与本地路径的双向转换（主进程 protocol.handle 与渲染层共用）
 * - 支持的媒体扩展名白名单（主进程白名单校验与渲染层目录过滤共用）
 *
 * URL 形状（standard scheme 必须有 hostname）：
 * - Windows 盘符路径  `C:\a\b.png`            → `local-image://c/a/b.png`（盘符作 host）
 * - UNC / WSL 路径    `\\wsl.localhost\U\x`   → `local-image://wsl.localhost/U/x`
 * - POSIX 绝对路径    `/a/b.png`              → `local-image://posix/a/b.png`（固定 host）
 * - 远程图片代理      `local-image://remote-fetch/?url=<encoded>`（主进程 net.fetch 代理，绕过 CSP/CORS）
 */

export const LOCAL_IMAGE_SCHEME = 'local-image';

/** POSIX 绝对路径的固定 host（盘符 host 恒为单字母，二者不会撞） */
const POSIX_HOST = 'posix';

/** 远程图片代理的保留 host */
export const REMOTE_FETCH_HOST = 'remote-fetch';

export const IMAGE_EXTENSIONS = [
  'png',
  'jpg',
  'jpeg',
  'gif',
  'webp',
  'bmp',
  'svg',
  'jfif',
  'avif',
] as const;

export const VIDEO_EXTENSIONS = ['mp4', 'webm', 'ogg', 'ogv', 'mov'] as const;

export const MEDIA_EXTENSIONS: readonly string[] = [...IMAGE_EXTENSIONS, ...VIDEO_EXTENSIONS];

/** 取小写扩展名（不带点）；无扩展名返回空串 */
export function mediaExtension(pathOrUrl: string): string {
  const clean = pathOrUrl.split(/[?#]/)[0] ?? '';
  const idx = clean.lastIndexOf('.');
  if (idx < 0) return '';
  return clean.slice(idx + 1).toLowerCase();
}

export function isMediaPath(pathOrUrl: string): boolean {
  return MEDIA_EXTENSIONS.includes(mediaExtension(pathOrUrl));
}

export function isVideoPath(pathOrUrl: string): boolean {
  return (VIDEO_EXTENSIONS as readonly string[]).includes(mediaExtension(pathOrUrl));
}

/** 本地绝对路径 → local-image:// URL（逐段 encodeURIComponent，保住空格/中文/#）*/
export function toLocalImageUrl(filePath: string): string {
  const normalized = filePath.replace(/\\/g, '/');

  // UNC：//server/share/...（含 WSL 的 \\wsl.localhost\...）
  if (normalized.startsWith('//')) {
    const [host, ...rest] = normalized.slice(2).split('/').filter(Boolean);
    return `${LOCAL_IMAGE_SCHEME}://${host}/${rest.map(encodeURIComponent).join('/')}`;
  }

  // Windows 盘符：C:/...
  const drive = /^([a-zA-Z]):\/(.*)$/.exec(normalized);
  if (drive) {
    const segments = drive[2].split('/').filter(Boolean).map(encodeURIComponent);
    return `${LOCAL_IMAGE_SCHEME}://${drive[1].toLowerCase()}/${segments.join('/')}`;
  }

  // POSIX 绝对路径
  const segments = normalized.split('/').filter(Boolean).map(encodeURIComponent);
  return `${LOCAL_IMAGE_SCHEME}://${POSIX_HOST}/${segments.join('/')}`;
}

/** local-image:// URL → 本地绝对路径；形状不合法返回 null */
export function localImageUrlToPath(url: URL): string | null {
  const host = url.hostname;
  if (!host || host === REMOTE_FETCH_HOST) return null;
  const segments = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
  if (host === POSIX_HOST) {
    return `/${segments.join('/')}`;
  }
  if (/^[a-z]$/i.test(host)) {
    return `${host.toUpperCase()}:\\${segments.join('\\')}`;
  }
  return `\\\\${host}\\${segments.join('\\')}`;
}

/** 远程图片走主进程代理的 URL；nonce 用于手动/定时刷新时绕开缓存 */
export function toRemoteImageProxyUrl(remoteUrl: string, nonce = 0): string {
  const bust = nonce > 0 ? `&_t=${nonce}` : '';
  return `${LOCAL_IMAGE_SCHEME}://${REMOTE_FETCH_HOST}/?url=${encodeURIComponent(remoteUrl)}${bust}`;
}
