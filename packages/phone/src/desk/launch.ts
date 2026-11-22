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

export function clearDeskMeta(storage: Pick<Storage, 'removeItem'>, pairId: string): void {
  try {
    storage.removeItem(key(pairId));
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

/** iOS PWA 在后台久了偶发 SW / 浏览器存储卡死（只有划掉重开才恢复）：启动路径上的存储调用不能无限等 */
export function withTimeout<T>(task: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(fallback), ms);
    task.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        clearTimeout(timer);
        resolve(fallback);
      }
    );
  });
}

const BOOT_RETRY_KEY = 'enso-desk-boot-retry';

/** 启动卡住时是否自动整页重载：同一页面会话只重载一次，避免死循环 */
export function bootRetry(storage: KeyValue): boolean {
  try {
    if (storage.getItem(BOOT_RETRY_KEY)) return false;
    storage.setItem(BOOT_RETRY_KEY, '1');
    return true;
  } catch {
    return false;
  }
}

export function clearBootRetry(storage: Pick<Storage, 'removeItem'>): void {
  try {
    storage.removeItem(BOOT_RETRY_KEY);
  } catch {}
}

/** 发起重载后旧页面还在：说明重载本身也卡住了（重载请求同样挂起） */
const RELOAD_HUNG_MS = 8000;
const KILL_HINT = '请从后台划掉 EnsoCode 再打开。';

/** 启动卡住：写明卡在哪一步再重载一次；重载也卡住或再次卡住时提示划掉重开 */
export function handleBootStuck(
  stage: string,
  deps: {
    storage: KeyValue;
    show(text: string): void;
    reload(): void;
    later(fn: () => void, ms: number): void;
  }
): void {
  if (!bootRetry(deps.storage)) {
    deps.show(`启动卡住了（${stage}）。${KILL_HINT}`);
    return;
  }
  deps.show(`启动卡住（${stage}），正在重新加载…`);
  deps.later(() => deps.show(`重新加载也卡住了（${stage}）。${KILL_HINT}`), RELOAD_HUNG_MS);
  deps.reload();
}

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
