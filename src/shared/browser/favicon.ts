import { toRemoteImageProxyUrl } from '@shared/localImage';

/** 标签头只收 http(s) 图标，再走 local-image 代理（renderer CSP 禁 https 图） */
export function pickFaviconUrl(urls: readonly string[]): string | null {
  for (const raw of urls) {
    if (typeof raw !== 'string' || !raw.trim()) continue;
    try {
      const href = new URL(raw).href;
      if (href.startsWith('http://') || href.startsWith('https://')) {
        return toRemoteImageProxyUrl(href);
      }
    } catch {}
  }
  return null;
}
