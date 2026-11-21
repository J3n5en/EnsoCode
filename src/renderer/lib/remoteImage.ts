import { REMOTE_LOCAL_IMAGE_PREFIX_KEY } from '@shared/localImage';
import { pruneSecretaryAvatars } from '@shared/remoteImageCache';

const FIRST_RETRY_MS = 2_000;
const MAX_RETRY_MS = 60_000;

/** 远程桌面（浏览器）里本地图片的路由前缀 /desk/li/<pairId>/；桌面端为 null */
export function remoteImagePrefix(): string | null {
  const prefix = (globalThis as Record<string, unknown>)[REMOTE_LOCAL_IMAGE_PREFIX_KEY];
  return typeof prefix === 'string' ? prefix : null;
}

/** 远程桌面里图没取到（多为桌面还没连上）：后台按退避重试，取到了再通知换回图片 */
export function retryRemoteImage(
  src: string,
  load: (src: string) => Promise<boolean>,
  onLoaded: () => void
): () => void {
  let delay = FIRST_RETRY_MS;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout>;
  const attempt = () => {
    void load(src).then((ok) => {
      if (stopped) return;
      if (ok) return onLoaded();
      delay = Math.min(delay * 2, MAX_RETRY_MS);
      timer = setTimeout(attempt, delay);
    });
  };
  timer = setTimeout(attempt, delay);
  return () => {
    stopped = true;
    clearTimeout(timer);
  };
}

export const probeImage = (src: string): Promise<boolean> =>
  new Promise((resolve) => {
    const image = new Image();
    image.onload = () => resolve(true);
    image.onerror = () => resolve(false);
    image.src = src;
  });

/** 秘书清单到了：删掉已不存在的秘书留在本机的头像副本（只在远程桌面里） */
export function pruneRemoteSecretaryAvatars(secretaryIds: string[]): void {
  const prefix = remoteImagePrefix();
  if (!prefix || typeof caches === 'undefined') return;
  void pruneSecretaryAvatars(caches, prefix, secretaryIds).catch(() => {});
}
