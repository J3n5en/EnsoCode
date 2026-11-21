/** 宿主 /meta 的结果：renderer 构建号决定 SW 缓存与资源路径 */
export interface DeskMeta {
  version: string;
  platform: string;
}

type KeyValue = Pick<Storage, 'getItem' | 'setItem'>;

const key = (pairId: string) => `enso-desk-meta:${pairId}`;
const BUILD = /^[\w.+-]{1,64}$/;

/** 上次连上时的构建：启动时据此直接从 SW 缓存起 renderer，不必等一次往返 */
export function loadDeskMeta(storage: KeyValue, pairId: string): DeskMeta | null {
  try {
    const value = JSON.parse(storage.getItem(key(pairId)) ?? '') as Partial<DeskMeta> | null;
    if (!value || typeof value.version !== 'string' || typeof value.platform !== 'string')
      return null;
    if (!BUILD.test(value.version) || value.version.includes('..')) return null;
    return { version: value.version, platform: value.platform };
  } catch {
    return null;
  }
}

export function saveDeskMeta(storage: KeyValue, pairId: string, meta: DeskMeta): void {
  try {
    storage.setItem(key(pairId), JSON.stringify(meta));
  } catch {}
}

/** 页面常驻时桌面升级重启：重连握手报的构建与在用的不同，就该整页换到新构建 */
export function upgradedBuild(
  inUse: string,
  reported: string | undefined,
  platform: string
): DeskMeta | null {
  if (!inUse || !reported || reported === inUse) return null;
  if (!BUILD.test(reported) || reported.includes('..')) return null;
  return { version: reported, platform };
}

export const deskBase = (pairId: string, version: string): string =>
  `/desk/r/${encodeURIComponent(pairId)}/${encodeURIComponent(version)}`;

/** 入口页最先进缓存，下载中途打断也会留下它；renderer 真正跑起来后才记完成标记 */
const readyUrl = (origin: string, base: string) => `${origin}${base}/.ready`;

export async function buildReady(cache: Pick<Cache, 'match'>, origin: string, base: string) {
  return Boolean(await cache.match(readyUrl(origin, base)));
}

export async function markBuildReady(cache: Pick<Cache, 'put'>, origin: string, base: string) {
  await cache.put(readyUrl(origin, base), new Response('1'));
}

const mb = (bytes: number) => (bytes / 1024 / 1024).toFixed(1);

/** 「1.2 / 4.8 MB」；旧桌面不报总量时只显示已下载。估算有偏差，未完成前不超过总量 */
export function downloadProgress(done: number, total?: number): string {
  if (!total) return `${mb(done)} MB`;
  return `${mb(Math.min(done, total * 0.99))} / ${mb(total)} MB`;
}
