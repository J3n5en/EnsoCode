import { describe, expect, it } from 'vitest';
import { hadPairing, requestPersistence, storageLossNotice, syncPairedMark } from './storageGuard';

function memoryCaches() {
  const stores = new Map<string, Map<string, Response>>();
  return {
    stores,
    async open(name: string) {
      let store = stores.get(name);
      if (!store) {
        store = new Map();
        stores.set(name, store);
      }
      const s = store;
      return {
        put: async (url: string, res: Response) => void s.set(url, res),
        match: async (url: string) => s.get(url),
      } as unknown as Cache;
    },
    async delete(name: string) {
      return stores.delete(name);
    },
  };
}

describe('requestPersistence', () => {
  it('已持久不再申请；否则申请并返回结果', async () => {
    let asked = 0;
    const persist = async () => {
      asked++;
      return false;
    };
    expect(await requestPersistence({ persisted: async () => true, persist })).toBe(true);
    expect(asked).toBe(0);
    expect(await requestPersistence({ persisted: async () => false, persist })).toBe(false);
    expect(asked).toBe(1);
  });

  it('不支持或抛错时返回 null，不打断启动', async () => {
    expect(await requestPersistence(undefined)).toBeNull();
    expect(await requestPersistence({})).toBeNull();
    expect(
      await requestPersistence({
        persist: async () => {
          throw new Error('denied');
        },
      })
    ).toBeNull();
  });
});

describe('配对标记', () => {
  it('配过对留下标记，解绑全部后清掉', async () => {
    const c = memoryCaches();
    expect(await hadPairing(c)).toBe(false);
    await syncPairedMark(true, c);
    expect(await hadPairing(c)).toBe(true);
    await syncPairedMark(false, c);
    expect(await hadPairing(c)).toBe(false);
  });

  it('没有 Cache Storage 时不报错', async () => {
    await syncPairedMark(true, undefined);
    expect(await hadPairing(undefined)).toBe(false);
  });
});

describe('storageLossNotice', () => {
  it('有配对时不提示', () => {
    expect(storageLossNotice({ paired: true, marked: true, standalone: true })).toBeNull();
  });
  it('凭据没了但标记还在：明确说被清理', () => {
    expect(storageLossNotice({ paired: false, marked: true, standalone: false })).toContain(
      '被系统清理'
    );
  });
  it('主屏打开且什么都没有：提示可能被 iOS 清理；浏览器里首次打开不提示', () => {
    expect(storageLossNotice({ paired: false, marked: false, standalone: true })).toContain('iOS');
    expect(storageLossNotice({ paired: false, marked: false, standalone: false })).toBeNull();
  });
});
