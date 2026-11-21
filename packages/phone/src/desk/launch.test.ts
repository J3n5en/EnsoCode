import { describe, expect, it, vi } from 'vitest';
import {
  bootRetry,
  buildReady,
  clearBootRetry,
  deskBase,
  downloadProgress,
  handleBootStuck,
  loadDeskMeta,
  markBuildReady,
  saveDeskMeta,
  upgradedBuild,
  withTimeout,
} from './launch';

class MemoryStorage {
  private map = new Map<string, string>();
  getItem(key: string) {
    return this.map.get(key) ?? null;
  }
  setItem(key: string, value: string) {
    this.map.set(key, value);
  }
}

describe('desk launch meta', () => {
  it('remembers the last renderer build per desktop', () => {
    const storage = new MemoryStorage();
    saveDeskMeta(storage, 'pair-a', { version: '0.2.9-abc', platform: 'darwin' });
    expect(loadDeskMeta(storage, 'pair-a')).toEqual({ version: '0.2.9-abc', platform: 'darwin' });
    expect(loadDeskMeta(storage, 'pair-b')).toBeNull();
  });

  it('ignores corrupt or unsafe entries', () => {
    const storage = new MemoryStorage();
    storage.setItem('enso-desk-meta:p', '{');
    expect(loadDeskMeta(storage, 'p')).toBeNull();
    storage.setItem('enso-desk-meta:p', JSON.stringify({ version: '../x', platform: 'darwin' }));
    expect(loadDeskMeta(storage, 'p')).toBeNull();
    storage.setItem('enso-desk-meta:p', JSON.stringify({ version: '1', platform: 7 }));
    expect(loadDeskMeta(storage, 'p')).toBeNull();
  });

  it('builds the service-worker path for a build', () => {
    expect(deskBase('a/b', '0.2.9-x')).toBe('/desk/r/a%2Fb/0.2.9-x');
  });

  it('重连时宿主报的构建与在用的不同才算升级；没在用构建或报得不合法都不算', () => {
    expect(upgradedBuild('0.3.12-a', '0.3.12-b', 'darwin')).toEqual({
      version: '0.3.12-b',
      platform: 'darwin',
    });
    expect(upgradedBuild('0.3.12-a', '0.3.12-a', 'darwin')).toBeNull();
    expect(upgradedBuild('', '0.3.12-b', 'darwin')).toBeNull();
    expect(upgradedBuild('0.3.12-a', '../x', 'darwin')).toBeNull();
    expect(upgradedBuild('0.3.12-a', undefined, 'darwin')).toBeNull();
  });

  it('存储调用卡住或出错时按超时给回退值，不让启动无限等', async () => {
    vi.useFakeTimers();
    try {
      const hung = withTimeout(new Promise<string>(() => {}), 1000, 'fallback');
      vi.advanceTimersByTime(1000);
      await expect(hung).resolves.toBe('fallback');
      await expect(withTimeout(Promise.resolve('ok'), 1000, 'fallback')).resolves.toBe('ok');
      await expect(withTimeout(Promise.reject(new Error('x')), 1000, 'fallback')).resolves.toBe(
        'fallback'
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('启动卡住只自动重载一次；成功启动后清掉标记，下次卡住还能再自动重载', () => {
    const store = new Map<string, string>();
    const storage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    };
    expect(bootRetry(storage)).toBe(true);
    expect(bootRetry(storage)).toBe(false);
    clearBootRetry(storage);
    expect(bootRetry(storage)).toBe(true);
  });

  it('启动卡住：先说明卡在哪并重载；重载本身也卡住时改提示划掉重开；第二次卡住不再重载', () => {
    const store = new Map<string, string>();
    const storage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    };
    const shown: string[] = [];
    const timers: Array<() => void> = [];
    let reloads = 0;
    const deps = {
      storage,
      show: (text: string) => void shown.push(text),
      reload: () => void reloads++,
      later: (fn: () => void) => void timers.push(fn),
    };

    handleBootStuck('注册 Service Worker', deps);
    expect(reloads).toBe(1);
    expect(shown.at(-1)).toContain('注册 Service Worker');
    expect(shown.at(-1)).not.toContain('划掉');
    timers[0]?.();
    expect(shown.at(-1)).toContain('注册 Service Worker');
    expect(shown.at(-1)).toContain('划掉');

    handleBootStuck('启动隧道', deps);
    expect(reloads).toBe(1);
    expect(shown.at(-1)).toContain('启动隧道');
    expect(shown.at(-1)).toContain('划掉');
  });
});

describe('downloadProgress', () => {
  it('shows downloaded / total, never reaching the total before load finishes', () => {
    const MB = 1024 * 1024;
    expect(downloadProgress(1.2 * MB, 4.8 * MB)).toBe('1.2 / 4.8 MB');
    expect(downloadProgress(6 * MB, 4.8 * MB)).toBe('4.8 / 4.8 MB');
    expect(downloadProgress(5 * MB, 10 * MB)).toBe('5.0 / 10.0 MB');
  });

  it('falls back to downloaded only when an old desktop reports no total', () => {
    expect(downloadProgress(2.2 * 1024 * 1024)).toBe('2.2 MB');
  });
});

class MemoryCache {
  map = new Map<string, Response>();
  async match(url: string) {
    return this.map.get(url);
  }
  async put(url: string, response: Response) {
    this.map.set(url, response);
  }
}

describe('build readiness', () => {
  const origin = 'https://relay.example';
  const base = deskBase('pair', '1.0.0-abc');

  it('does not treat an interrupted download (entry page only) as launchable', async () => {
    const cache = new MemoryCache();
    await cache.put(`${origin}${base}/index.html`, new Response('<html>'));
    expect(await buildReady(cache, origin, base)).toBe(false);
  });

  it('is launchable once the renderer has booted, per build', async () => {
    const cache = new MemoryCache();
    await markBuildReady(cache, origin, base);
    expect(await buildReady(cache, origin, base)).toBe(true);
    expect(await buildReady(cache, origin, deskBase('pair', '1.0.1-def'))).toBe(false);
  });
});
