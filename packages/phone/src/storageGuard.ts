/**
 * 本地存储防丢：配对凭据只在 localStorage，iOS 存储压力下可能整源清掉。
 * 申请持久存储降低被清概率；另在 Cache Storage 留一个「配过对」标记，凭据没了标记还在就能说清楚原因。
 */

const MARK_CACHE = 'enso-phone-mark';
const MARK_URL = '/__paired';

type Persist = Partial<Pick<StorageManager, 'persist' | 'persisted'>>;
type MarkCaches = Pick<CacheStorage, 'open' | 'delete'>;

const defaultCaches = (): MarkCaches | undefined =>
  typeof caches === 'undefined' ? undefined : caches;

/** 已持久返回 true；不支持或失败返回 null（是否授予由浏览器启发式决定，不弹窗） */
export async function requestPersistence(
  storage: Persist | undefined = typeof navigator === 'undefined' ? undefined : navigator.storage
): Promise<boolean | null> {
  if (!storage?.persist) return null;
  try {
    if (await storage.persisted?.()) return true;
    return await storage.persist();
  } catch {
    return null;
  }
}

export async function syncPairedMark(
  paired: boolean,
  cachesApi: MarkCaches | undefined = defaultCaches()
): Promise<void> {
  if (!cachesApi) return;
  try {
    if (!paired) {
      await cachesApi.delete(MARK_CACHE);
      return;
    }
    const cache = await cachesApi.open(MARK_CACHE);
    await cache.put(MARK_URL, new Response('1'));
  } catch {}
}

export async function hadPairing(
  cachesApi: MarkCaches | undefined = defaultCaches()
): Promise<boolean> {
  if (!cachesApi) return false;
  try {
    return Boolean(await (await cachesApi.open(MARK_CACHE)).match(MARK_URL));
  } catch {
    return false;
  }
}

/** 没有可用配对时要不要说明「可能被系统清理」：有标记时确定，主屏打开时提示可能 */
export function storageLossNotice(input: {
  paired: boolean;
  marked: boolean;
  standalone: boolean;
}): string | null {
  if (input.paired) return null;
  if (input.marked)
    return '这台手机上保存的配对信息不见了，可能被系统清理了存储。请在桌面端「设置 → 手机」重新生成配对码，再扫码配对。';
  if (input.standalone) return '如果之前配对过：iOS 可能清理了本地数据，需要重新扫码配对。';
  return null;
}
