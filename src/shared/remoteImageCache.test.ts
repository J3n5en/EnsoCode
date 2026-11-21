import { describe, expect, it } from 'vitest';
import {
  cachedRemoteImage,
  pruneRemoteImages,
  pruneSecretaryAvatars,
  REMOTE_IMAGE_CACHE,
  type RemoteImageCaches,
  rehydrateImages,
  remoteImageIdentity,
  snapshotImage,
  storeRemoteImage,
} from './remoteImageCache';

class FakeCache {
  entries = new Map<string, Response>();
  async match(key: RequestInfo | URL) {
    return this.entries.get(String(key))?.clone();
  }
  async put(key: RequestInfo | URL, response: Response) {
    const url = String(key);
    this.entries.delete(url);
    this.entries.set(url, response);
  }
  async delete(key: RequestInfo | URL) {
    return this.entries.delete(typeof key === 'string' ? key : (key as Request).url);
  }
  async keys() {
    return [...this.entries.keys()].map((url) => new Request(url));
  }
}

function fakeCaches(): RemoteImageCaches & { cache: FakeCache; opened: string[] } {
  const cache = new FakeCache();
  const opened: string[] = [];
  return {
    cache,
    opened,
    open: async (name: string) => {
      opened.push(name);
      return cache as unknown as Cache;
    },
  };
}

const ORIGIN = 'https://relay.test';
const li = (pair: string, inner: string) =>
  `${ORIGIN}/desk/li/${pair}/${encodeURIComponent(inner)}`;
const avatar = (pair: string, v: number, h: string, s?: string) =>
  li(pair, `local-image://secretary-avatar/avatar.png?v=${v}&h=${h}${s ? `&s=${s}` : ''}`);
const gif = (byte: number) => ({ status: 200, mime: 'image/gif', body: new Uint8Array([byte]) });
const bytes = async (response: Response | undefined) =>
  response ? [...new Uint8Array(await response.arrayBuffer())] : null;

describe('remoteImageIdentity', () => {
  it('keys versioned avatars and plugin assets by what they depict, not by version', () => {
    expect(remoteImageIdentity(avatar('p1', 3, 'aa', 'ken'))).toBe(
      remoteImageIdentity(avatar('p1', 4, 'bb', 'ken'))
    );
    expect(remoteImageIdentity(avatar('p1', 3, 'aa', 'ken'))).not.toBe(
      remoteImageIdentity(avatar('p1', 3, 'aa', 'mio'))
    );
    expect(remoteImageIdentity(avatar('p1', 3, 'aa', 'ken'))).not.toBe(
      remoteImageIdentity(avatar('p2', 3, 'aa', 'ken'))
    );
    expect(remoteImageIdentity(li('p1', 'local-image://bot-avatar/b1?v=2'))).toBeTruthy();
    expect(remoteImageIdentity(li('p1', 'local-image://plugin-asset/x/icon.png?v=7'))).toBeTruthy();
    const shot = (name: string) => li('p1', `local-image://secretary-report/c1/${name}?v=1`);
    expect(remoteImageIdentity(shot('aa.png'))).toBeTruthy();
    expect(remoteImageIdentity(shot('aa.png'))).not.toBe(remoteImageIdentity(shot('bb.png')));
  });

  it('does not persist path-addressed or proxied images (no host paths on the phone)', () => {
    expect(remoteImageIdentity(li('p1', 'local-image://posix/Users/me/a.png'))).toBeNull();
    expect(remoteImageIdentity(li('p1', 'local-image://c/Users/me/a.png'))).toBeNull();
    expect(
      remoteImageIdentity(li('p1', 'local-image://remote-fetch/?url=https%3A%2F%2Fx/a.png'))
    ).toBeNull();
    expect(
      remoteImageIdentity(li('p1', 'local-image://secretary-avatar/avatar.png?s=ken'))
    ).toBeNull();
    expect(remoteImageIdentity(`${ORIGIN}/desk/r/p1/build/index.html`)).toBeNull();
    expect(remoteImageIdentity(`${ORIGIN}/desk/li/p1/%E0%A4%A`)).toBeNull();
  });
});

describe('remote image cache', () => {
  it('serves a stored avatar immediately on the next launch', async () => {
    const caches = fakeCaches();
    const url = avatar('p1', 3, 'aa', 'ken');
    expect(await cachedRemoteImage(caches, url)).toBeUndefined();
    await storeRemoteImage(caches, url, gif(1));
    const hit = await cachedRemoteImage(caches, url);
    expect(hit?.headers.get('content-type')).toBe('image/gif');
    expect(await bytes(hit)).toEqual([1]);
    expect(caches.opened.every((name) => name === REMOTE_IMAGE_CACHE)).toBe(true);
    expect(REMOTE_IMAGE_CACHE.startsWith('enso-desk-')).toBe(false);
  });

  it('replaces the previous version of the same avatar', async () => {
    const caches = fakeCaches();
    await storeRemoteImage(caches, avatar('p1', 3, 'aa', 'ken'), gif(1));
    await storeRemoteImage(caches, avatar('p1', 3, 'aa', 'mio'), gif(9));
    await storeRemoteImage(caches, avatar('p1', 4, 'bb', 'ken'), gif(2));
    expect(await cachedRemoteImage(caches, avatar('p1', 3, 'aa', 'ken'))).toBeUndefined();
    expect(await bytes(await cachedRemoteImage(caches, avatar('p1', 4, 'bb', 'ken')))).toEqual([2]);
    expect(await bytes(await cachedRemoteImage(caches, avatar('p1', 3, 'aa', 'mio')))).toEqual([9]);
  });

  it('skips failures, non-images, oversized bodies and unversioned urls', async () => {
    const caches = fakeCaches();
    const url = avatar('p1', 3, 'aa', 'ken');
    await storeRemoteImage(caches, url, {
      status: 504,
      mime: 'text/plain',
      body: new Uint8Array(),
    });
    await storeRemoteImage(caches, url, {
      status: 200,
      mime: 'text/html',
      body: new Uint8Array([1]),
    });
    await storeRemoteImage(caches, url, {
      status: 200,
      mime: 'image/gif',
      body: new Uint8Array(9 * 1024 * 1024),
    });
    await storeRemoteImage(caches, li('p1', 'local-image://posix/a.png'), gif(1));
    expect(caches.cache.entries.size).toBe(0);
  });

  it('keeps at most the newest entries', async () => {
    const caches = fakeCaches();
    for (let i = 0; i < 130; i++)
      await storeRemoteImage(caches, li('p1', `local-image://bot-avatar/b${i}?v=1`), gif(i));
    expect(caches.cache.entries.size).toBe(120);
    expect(await cachedRemoteImage(caches, li('p1', 'local-image://bot-avatar/b0?v=1'))).toBe(
      undefined
    );
    expect(await cachedRemoteImage(caches, li('p1', 'local-image://bot-avatar/b129?v=1'))).not.toBe(
      undefined
    );
  });

  it('drops avatars of deleted secretaries on that desktop only', async () => {
    const caches = fakeCaches();
    await storeRemoteImage(caches, avatar('p1', 1, 'aa', 'ken'), gif(1));
    await storeRemoteImage(caches, avatar('p1', 1, 'aa', 'mio'), gif(2));
    await storeRemoteImage(caches, avatar('p2', 1, 'aa', 'mio'), gif(3));
    await storeRemoteImage(caches, li('p1', 'local-image://bot-avatar/b1?v=1'), gif(4));
    await pruneSecretaryAvatars(caches, '/desk/li/p1/', ['ken']);
    expect(await cachedRemoteImage(caches, avatar('p1', 1, 'aa', 'mio'))).toBeUndefined();
    expect(await cachedRemoteImage(caches, avatar('p1', 1, 'aa', 'ken'))).toBeDefined();
    expect(await cachedRemoteImage(caches, avatar('p2', 1, 'aa', 'mio'))).toBeDefined();
    expect(
      await cachedRemoteImage(caches, li('p1', 'local-image://bot-avatar/b1?v=1'))
    ).toBeDefined();
  });

  it('drops images of unpaired desktops', async () => {
    const caches = fakeCaches();
    await storeRemoteImage(caches, avatar('p1', 1, 'aa', 'ken'), gif(1));
    await storeRemoteImage(caches, avatar('p2', 1, 'aa', 'ken'), gif(2));
    await pruneRemoteImages(caches, ['p2']);
    expect(await cachedRemoteImage(caches, avatar('p1', 1, 'aa', 'ken'))).toBeUndefined();
    expect(await cachedRemoteImage(caches, avatar('p2', 1, 'aa', 'ken'))).toBeDefined();
  });

  it('lets a stale snapshot show the newest cached version of the same avatar', async () => {
    const caches = fakeCaches();
    await storeRemoteImage(caches, avatar('p1', 4, 'bb', 'ken'), gif(2));
    const hit = await snapshotImage(caches, avatar('p1', 3, 'aa', 'ken'));
    expect(await bytes(hit)).toEqual([2]);
    expect(await snapshotImage(caches, avatar('p1', 3, 'aa', 'mio'))).toBeUndefined();
    expect(await snapshotImage(caches, li('p1', 'local-image://posix/a.png'))).toBeUndefined();
  });
});

describe('rehydrateImages', () => {
  const html = (src: string) =>
    `<div><img data-enso="secretary-avatar" src="${src}" class="a"><img src="/desk/r/p1/b/x.png"><img alt="" src="${src}"></div>`;

  it('points cached images at local copies and strips the rest instead of leaving broken images', async () => {
    const cached = '/desk/li/p1/local-image%3A%2F%2Fsecretary-avatar%2Favatar.png%3Fv%3D3';
    const missing = '/desk/li/p1/local-image%3A%2F%2Fposix%2Fa.png';
    const seen: string[] = [];
    const out = await rehydrateImages(
      `${html(cached)}${html(`${ORIGIN}${missing}`)}`,
      async (src) => {
        seen.push(src);
        return src.endsWith(cached) ? 'blob:local/1' : null;
      }
    );
    expect(seen).toEqual([cached, `${ORIGIN}${missing}`]);
    expect(out).toBe(
      `${html('blob:local/1')}<div><img data-enso="secretary-avatar" class="a"><img src="/desk/r/p1/b/x.png"><img alt=""></div>`
    );
  });

  it('strips every remote image when lookups fail', async () => {
    const src = '/desk/li/p1/local-image%3A%2F%2Fbot-avatar%2Fb%3Fv%3D1';
    const out = await rehydrateImages(html(src), async () => {
      throw new Error('storage');
    });
    expect(out).not.toContain('/desk/li/');
  });
});
