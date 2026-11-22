/**
 * 远程桌面（PWA /desk）图片的本地缓存：/desk/li/<pairId>/<local-image URL> 经隧道向桌面取，
 * 冷启动时桌面还没连上，取不到就只能空着或裂图。按版本寻址的图（秘书/成员头像、插件图片）
 * 内容随地址变，取到过就存在 Cache Storage，下次直接用；地址里带磁盘路径或外链的不落盘。
 */

import {
  BOT_AVATAR_HOST,
  LOCAL_IMAGE_SCHEME,
  PLUGIN_ASSET_HOST,
  SECRETARY_AVATAR_HOST,
  SECRETARY_REPORT_HOST,
} from './localImage';

/** 不能以 enso-desk- 开头：desk 壳会清掉该前缀下不认识的缓存 */
export const REMOTE_IMAGE_CACHE = 'enso-remote-images';
const MAX_ENTRIES = 120;
const MAX_BYTES = 8 * 1024 * 1024;

export type RemoteImageCaches = Pick<CacheStorage, 'open'>;

export interface RemoteImageAsset {
  status: number;
  mime: string;
  body: Uint8Array;
}

const LI_PATH = /\/desk\/li\/([^/]+)\/([^?#]+)$/;

function parse(url: string): { pair: string; identity: string } | null {
  const match = LI_PATH.exec(url.startsWith('/') ? url : safePath(url));
  if (!match) return null;
  let inner: URL;
  try {
    inner = new URL(decodeURIComponent(match[2]));
  } catch {
    return null;
  }
  if (inner.protocol !== `${LOCAL_IMAGE_SCHEME}:` || !inner.searchParams.get('v')) return null;
  const host = inner.hostname;
  const id =
    host === SECRETARY_AVATAR_HOST
      ? `${host}?s=${inner.searchParams.get('s') ?? ''}`
      : host === BOT_AVATAR_HOST || host === PLUGIN_ASSET_HOST || host === SECRETARY_REPORT_HOST
        ? `${host}${inner.pathname}`
        : null;
  return id ? { pair: match[1], identity: `${match[1]}\n${id}` } : null;
}

function safePath(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return '';
  }
}

/** 同一张图（不论版本）的身份；不可缓存的地址返回 null */
export function remoteImageIdentity(url: string): string | null {
  return parse(url)?.identity ?? null;
}

const keyOf = (request: Request | string) => (typeof request === 'string' ? request : request.url);

export async function cachedRemoteImage(
  caches: RemoteImageCaches,
  url: string
): Promise<Response | undefined> {
  if (!parse(url)) return undefined;
  return (await caches.open(REMOTE_IMAGE_CACHE)).match(url);
}

/** 存下取到的图，并删掉同一张图的旧版本；超出条数从最早的开始丢 */
export async function storeRemoteImage(
  caches: RemoteImageCaches,
  url: string,
  asset: RemoteImageAsset
): Promise<void> {
  const parsed = parse(url);
  if (!parsed || asset.status !== 200 || !asset.mime.startsWith('image/')) return;
  if (asset.body.byteLength === 0 || asset.body.byteLength > MAX_BYTES) return;
  const cache = await caches.open(REMOTE_IMAGE_CACHE);
  const keys = (await cache.keys()).map(keyOf);
  const stale = keys.filter((key) => key !== url && parse(key)?.identity === parsed.identity);
  for (const key of stale) await cache.delete(key);
  await cache.put(
    url,
    new Response(asset.body.slice(), { headers: { 'Content-Type': asset.mime } })
  );
  const rest = keys.filter((key) => key !== url && !stale.includes(key));
  for (const key of rest.slice(0, Math.max(0, rest.length + 1 - MAX_ENTRIES)))
    await cache.delete(key);
}

/** 快照里的地址可能是旧版本：精确命中优先，否则用同一张图缓存着的版本 */
export async function snapshotImage(
  caches: RemoteImageCaches,
  url: string
): Promise<Response | undefined> {
  const parsed = parse(url);
  if (!parsed) return undefined;
  const cache = await caches.open(REMOTE_IMAGE_CACHE);
  const exact = await cache.match(url);
  if (exact) return exact;
  const same = (await cache.keys())
    .map(keyOf)
    .filter((key) => parse(key)?.identity === parsed.identity)
    .at(-1);
  return same ? cache.match(same) : undefined;
}

async function prune(caches: RemoteImageCaches, drop: (key: string) => boolean): Promise<void> {
  const cache = await caches.open(REMOTE_IMAGE_CACHE);
  for (const key of (await cache.keys()).map(keyOf)) if (drop(key)) await cache.delete(key);
}

/** 已取消配对的桌面：它的图全部删掉 */
export function pruneRemoteImages(caches: RemoteImageCaches, pairIds: string[]): Promise<void> {
  const keep = new Set(pairIds.map((id) => encodeURIComponent(id)));
  return prune(caches, (key) => {
    const pair = LI_PATH.exec(safePath(key))?.[1];
    return pair === undefined || !keep.has(pair);
  });
}

/** 秘书被删了：删掉该桌面（prefix 即 /desk/li/<pairId>/）下它的头像 */
export function pruneSecretaryAvatars(
  caches: RemoteImageCaches,
  prefix: string,
  secretaryIds: string[]
): Promise<void> {
  const pair = /^\/desk\/li\/([^/]+)\/$/.exec(prefix)?.[1];
  if (!pair) return Promise.resolve();
  const live = new Set(secretaryIds.map((id) => `${pair}\n${SECRETARY_AVATAR_HOST}?s=${id}`));
  const owner = `${pair}\n${SECRETARY_AVATAR_HOST}?s=`;
  return prune(caches, (key) => {
    const identity = parse(key)?.identity;
    return !!identity && identity.startsWith(owner) && identity !== owner && !live.has(identity);
  });
}

const SRC_ATTR = /\ssrc="((?:https?:\/\/[^/"]+)?\/desk\/li\/[^"]+)"/g;

/**
 * 快照（静态、无脚本、可能不经 SW）里的远程图：有本地副本的换成副本地址，没有的去掉 src，
 * 不留会裂图的地址。resolve 出错按没有副本处理。
 */
export async function rehydrateImages(
  html: string,
  resolve: (src: string) => Promise<string | null>
): Promise<string> {
  const sources = [...new Set([...html.matchAll(SRC_ATTR)].map((match) => match[1]))];
  const local = new Map<string, string | null>();
  for (const src of sources) local.set(src, await resolve(src).catch(() => null));
  return html.replace(SRC_ATTR, (_whole, src: string) => {
    const hit = local.get(src);
    return hit ? ` src="${hit}"` : '';
  });
}
