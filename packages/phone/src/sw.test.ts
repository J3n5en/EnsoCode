import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';
import { injectShellManifest } from './shellPrecache';

const ORIGIN = 'https://relay.test';
const SOURCE = fs.readFileSync(path.resolve(import.meta.dirname, '../public/sw.js'), 'utf8');
const V1 = 'aaaaaaaaaaaaaaaa';
const V2 = 'bbbbbbbbbbbbbbbb';
const V3 = 'cccccccccccccccc';
const FILES = ['/', '/desk', '/assets/desk-1.js', '/assets/desk-1.css'];

/** 去掉页面里的版本 meta，只比内容 */
const text = async (res: Response | undefined) =>
  (await res?.text())?.replace(/^<meta[^>]*\/>/, '');

const abs = (key: string) => (key.startsWith('/') ? `${ORIGIN}${key}` : key);

class FakeCaches {
  stores = new Map<string, Map<string, Response>>();
  async open(name: string) {
    let store = this.stores.get(name);
    if (!store) {
      store = new Map();
      this.stores.set(name, store);
    }
    const s = store;
    return {
      match: async (key: string) => s.get(abs(key))?.clone(),
      put: async (key: string, res: Response) => {
        s.set(abs(key), res.clone());
      },
      delete: async (key: string) => s.delete(abs(key)),
    };
  }
  async keys() {
    return [...this.stores.keys()];
  }
  async has(name: string) {
    return this.stores.has(name);
  }
  async delete(name: string) {
    return this.stores.delete(name);
  }
}

/** 中继：每个文件内容带上当前部署的版本号 */
function relay(state: { deployed: string; online: boolean; calls: string[]; missing: string[] }) {
  return async (input: string | { url: string }) => {
    const url = typeof input === 'string' ? abs(input) : input.url;
    state.calls.push(new URL(url).pathname);
    if (!state.online) throw new TypeError('Failed to fetch');
    const type = url.endsWith('.css')
      ? 'text/css'
      : url.endsWith('.js')
        ? 'text/javascript'
        : url.endsWith('.webmanifest')
          ? 'application/manifest+json'
          : url.endsWith('.png')
            ? 'image/png'
            : 'text/html';
    const pathname = new URL(url).pathname;
    // 和中继一样：不认识的 /assets 路径回退成 index.html
    const missing = pathname.startsWith('/assets/') && state.missing.includes(pathname);
    const page = type === 'text/html' || missing;
    const meta = page ? `<meta name="enso-shell" content="${state.deployed}" />` : '';
    const res = new Response(`${meta}${missing ? '/' : pathname}@${state.deployed}`, {
      headers: { 'Content-Type': missing ? 'text/html' : type },
    });
    Object.defineProperty(res, 'type', { value: 'basic' });
    return res;
  };
}

function boot(
  version: string | null,
  env: {
    caches: FakeCaches;
    net: ReturnType<typeof relay>;
    posted: unknown[];
    notifications?: { title: string; data?: { pending?: boolean } }[];
    badge?: number | null;
  }
) {
  const source = version ? injectShellManifest(SOURCE, version, FILES) : SOURCE;
  const listeners: Record<string, ((e: unknown) => void)[]> = {};
  const shown: { title: string; options: { data?: { pending?: boolean } } }[] = [];
  const self = {
    location: { origin: ORIGIN },
    addEventListener: (t: string, fn: (e: unknown) => void) => {
      listeners[t] = [...(listeners[t] ?? []), fn];
    },
    skipWaiting: () => {},
    clients: {
      claim: async () => {},
      matchAll: async () => [
        {
          url: `${ORIGIN}/desk?device=pair-1`,
          postMessage: (m: unknown, ports?: { postMessage: (d: unknown) => void }[]) => {
            env.posted.push(m);
            ports?.[0]?.postMessage({ status: 404, mime: 'text/plain', body: new Uint8Array() });
          },
        },
      ],
    },
    registration: {
      showNotification: async (title: string, options: { data?: { pending?: boolean } }) => {
        shown.push({ title, options });
        if (env.notifications) {
          env.notifications.push({ title, data: options.data });
        }
      },
      getNotifications: async () =>
        (env.notifications ?? []).map((n) => ({ title: n.title, data: n.data })),
      setAppBadge: async (n: number) => {
        if (env) env.badge = n;
      },
      clearAppBadge: async () => {
        if (env) env.badge = 0;
      },
    },
  };
  vm.runInNewContext(source, {
    self,
    caches: env.caches,
    fetch: env.net,
    Response,
    URL,
    setTimeout,
    clearTimeout,
    Promise,
    MessageChannel,
    Date,
    Number,
    String,
    JSON,
    Error,
  });
  const dispatch = async (type: string, event: Record<string, unknown>) => {
    const waits: Promise<unknown>[] = [];
    let responded: Promise<Response> | undefined;
    const e = {
      ...event,
      waitUntil: (p: Promise<unknown>) => waits.push(p),
      respondWith: (p: Promise<Response>) => {
        responded = p;
      },
    };
    for (const fn of listeners[type] ?? []) fn(e);
    const response = responded ? await responded : undefined;
    await Promise.all(waits);
    return response;
  };
  return {
    navigate: (pathAndQuery: string) =>
      dispatch('fetch', {
        request: { url: `${ORIGIN}${pathAndQuery}`, method: 'GET', mode: 'navigate' },
      }),
    asset: (p: string) =>
      dispatch('fetch', { request: { url: `${ORIGIN}${p}`, method: 'GET', mode: 'no-cors' } }),
    activate: () => dispatch('activate', {}),
    message: async (data: Record<string, unknown>) => {
      const replies: unknown[] = [];
      await dispatch('message', {
        data,
        ports: [{ postMessage: (m: unknown) => replies.push(m) }],
      });
      return replies[0];
    },
    push: async (payload: unknown) => {
      await dispatch('push', {
        data: { json: () => payload },
      });
      return shown[shown.length - 1];
    },
  };
}

function setup(deployed = V1) {
  const state = { deployed, online: true, calls: [] as string[], missing: [] as string[] };
  const env = { caches: new FakeCaches(), net: relay(state), posted: [] as unknown[] };
  return { state, env };
}

describe('sw.js 推送角标', () => {
  function pushEnv(notifications: { title: string; data?: { pending?: boolean } }[] = []) {
    const state = { deployed: V1, online: true, calls: [] as string[], missing: [] as string[] };
    const env = {
      caches: new FakeCaches(),
      net: relay(state),
      posted: [] as unknown[],
      notifications,
      badge: null as number | null,
    };
    return env;
  }

  it('pending 字段为 true 的通知计入角标，false 不计', async () => {
    const env = pushEnv();
    const sw = boot(V1, env);
    await sw.push({
      title: '修复登录 · 需要审批',
      body: 'bash · ls',
      sessionId: 's1',
      pending: true,
    });
    expect(env.badge).toBe(1);
    await sw.push({ title: '修复登录 · 回复完成', body: 'done', sessionId: 's1', pending: false });
    // 回复完成不计入，但上一条审批仍在 → 角标仍 1
    expect(env.badge).toBe(1);
  });

  it('旧载荷无 pending 字段：退回标题匹配（含新格式「会话名 · 需要审批」）', async () => {
    const env = pushEnv([
      { title: '修复登录 · 需要审批' }, // 新格式标题但无 pending 数据
      { title: '等待你的回答' }, // 旧格式精确标题
    ]);
    const sw = boot(V1, env);
    // 推送一条完成通知触发角标重算
    await sw.push({ title: 'x · 回复完成', body: '', sessionId: 's1', pending: false });
    expect(env.badge).toBe(2);
  });

  it('通知点击数据带 sessionId，pending 写入 notification data', async () => {
    const env = pushEnv();
    const sw = boot(V1, env);
    const shown = await sw.push({
      title: 't · 需要审批',
      body: 'b',
      sessionId: 's9',
      pending: true,
    });
    expect(shown?.options?.data).toEqual({ sessionId: 's9', pending: true });
  });
});

describe('sw.js 页面壳预缓存', () => {
  it('开发模式（清单为空）不接管导航和 /assets', async () => {
    const { env } = setup();
    const sw = boot(null, env);
    expect(await sw.navigate('/desk?device=x')).toBeUndefined();
    expect(await sw.asset('/assets/a-12345678.js')).toBeUndefined();
  });

  it('页面来问时把整套壳取齐，通知各页面', async () => {
    const { state, env } = setup();
    const sw = boot(V1, env);
    expect(await sw.message({ type: 'shell-check', version: V1 })).toEqual({
      ready: true,
      stale: false,
      version: V1,
    });
    expect(state.calls.sort()).toEqual([...FILES].sort());
    expect(env.posted).toContainEqual({ type: 'shell-ready' });
  });

  it('新版激活后不等页面来问也会去取（不阻塞激活）', async () => {
    const { state, env } = setup();
    await boot(V1, env).activate();
    await new Promise((r) => setTimeout(r, 10));
    expect(state.calls.sort()).toEqual([...FILES].sort());
    expect(env.posted).toContainEqual({ type: 'shell-ready' });
  });

  it('取齐后导航直接出缓存，不等中继', async () => {
    const { state, env } = setup();
    const sw = boot(V1, env);
    await sw.message({ type: 'shell-check', version: V1 });
    state.calls = [];
    state.deployed = V2;
    const res = await sw.navigate('/desk?device=abc');
    expect(await text(res)).toBe(`/desk@${V1}`);
    expect(await text(await sw.navigate('/desk.html'))).toBe(`/desk@${V1}`);
    expect(await text(await sw.navigate('/?session=s1'))).toBe(`/@${V1}`);
    expect(await text(await sw.asset('/assets/desk-1.js'))).toBe(`/assets/desk-1.js@${V1}`);
    expect(state.calls).toEqual([]);
  });

  it('还没取齐时走网络，顺手补齐；没网时 throw 交给浏览器', async () => {
    const { state, env } = setup();
    const sw = boot(V1, env);
    expect(await text(await sw.navigate('/desk'))).toBe(`/desk@${V1}`);
    expect(env.posted).toContainEqual({ type: 'shell-ready' });

    const fresh = setup();
    fresh.state.online = false;
    await expect(boot(V1, fresh.env).navigate('/desk')).rejects.toThrow();
    expect(state.online).toBe(true);
  });

  it('新版本还没装齐又没网：退回上一个版本的壳', async () => {
    const { state, env } = setup(V1);
    await boot(V1, env).message({ type: 'shell-check', version: V1 });
    state.online = false;
    const sw2 = boot(V2, env);
    expect(await text(await sw2.navigate('/desk?device=abc'))).toBe(`/desk@${V1}`);
    expect(await text(await sw2.asset('/assets/desk-1.css'))).toBe(`/assets/desk-1.css@${V1}`);
  });

  it('页面是旧版本缓存出来的才算过期；比 SW 还新的（网络拿的）不算', async () => {
    const { state, env } = setup(V1);
    await boot(V1, env).message({ type: 'shell-check', version: V1 });
    state.deployed = V2;
    const sw2 = boot(V2, env);
    expect(await sw2.message({ type: 'shell-check', version: V1 })).toMatchObject({
      ready: true,
      stale: true,
    });
    expect(await sw2.message({ type: 'shell-check', version: V3 })).toMatchObject({
      stale: false,
    });
    expect(await sw2.message({ type: 'shell-check', version: V2 })).toMatchObject({
      stale: false,
    });
    expect(await text(await sw2.navigate('/desk'))).toBe(`/desk@${V2}`);
  });

  it('中继已换成别的版本（或资源 404 回退成首页）：不写缓存，导航照旧走网络', async () => {
    const { state, env } = setup(V2);
    const sw = boot(V1, env);
    expect(await sw.message({ type: 'shell-check', version: V1 })).toMatchObject({ ready: false });
    expect(await env.caches.has(`enso-shell-${V1}`)).toBe(true);
    expect(await text(await sw.navigate('/desk'))).toBe(`/desk@${V2}`);
    expect(await text(await sw.navigate('/desk'))).toBe(`/desk@${V2}`);

    state.deployed = V1;
    state.missing = ['/assets/desk-1.js'];
    expect(await sw.message({ type: 'shell-check', version: V1 })).toMatchObject({ ready: false });
    await sw.asset('/assets/desk-1.js');
    state.missing = [];
    expect(await text(await sw.asset('/assets/desk-1.js'))).toBe(`/assets/desk-1.js@${V1}`);
  });

  it('只留当前和上一个版本', async () => {
    const { state, env } = setup(V1);
    await boot(V1, env).message({ type: 'shell-check', version: V1 });
    state.deployed = V2;
    await boot(V2, env).message({ type: 'shell-check', version: V2 });
    state.deployed = V3;
    await boot(V3, env).message({ type: 'shell-check', version: V3 });
    const shells = (await env.caches.keys()).filter((k) => k.startsWith('enso-shell-'));
    expect(shells).toEqual([`enso-shell-${V2}`, `enso-shell-${V3}`]);
  });

  it('启动卡住重载前打了标记：这次导航先走网络', async () => {
    const { state, env } = setup(V1);
    const sw = boot(V1, env);
    await sw.message({ type: 'shell-check', version: V1 });
    state.deployed = V2;
    await sw.message({ type: 'shell-fresh' });
    expect(await text(await sw.navigate('/desk'))).toBe(`/desk@${V2}`);
    // SW 进程被回收后标记仍在 Cache 里
    expect(await text(await boot(V1, env).navigate('/desk'))).toBe(`/desk@${V2}`);
  });

  it('/assets 未命中时走网络并留存，renderer 的 /desk/r 不归它管', async () => {
    const { state, env } = setup(V1);
    const sw = boot(V1, env);
    expect(await text(await sw.asset('/assets/index-abcdefgh.js'))).toBe(
      `/assets/index-abcdefgh.js@${V1}`
    );
    state.online = false;
    expect(await text(await sw.asset('/assets/index-abcdefgh.js'))).toBe(
      `/assets/index-abcdefgh.js@${V1}`
    );
  });

  it('/manifest.webmanifest 与 /icons/* 经 shellAsset 缓存供离线复用', async () => {
    const { state, env } = setup(V1);
    const sw = boot(V1, env);
    expect(await text(await sw.asset('/manifest.webmanifest'))).toBe(`/manifest.webmanifest@${V1}`);
    expect(await text(await sw.asset('/icons/icon-192.png'))).toBe(`/icons/icon-192.png@${V1}`);

    state.online = false;
    expect(await text(await sw.asset('/manifest.webmanifest'))).toBe(`/manifest.webmanifest@${V1}`);
    expect(await text(await sw.asset('/icons/icon-192.png'))).toBe(`/icons/icon-192.png@${V1}`);
  });

  it('/desk/li/* 命中 enso-remote-images 时由 SW 直接返回，不经过父页面桥接；未命中再问父页面', async () => {
    const { env } = setup(V1);
    const sw = boot(V1, env);
    const imgPath = '/desk/li/pair-1/local-image%3A%2F%2Fsecretary-avatar%3Fs%3Ddefault%26v%3D1';
    const imgCache = await env.caches.open('enso-remote-images');
    await imgCache.put(
      imgPath,
      new Response('cached-avatar-bytes', { status: 200, headers: { 'Content-Type': 'image/png' } })
    );

    const hit = await sw.asset(imgPath);
    expect(await text(hit)).toBe('cached-avatar-bytes');
    expect(env.posted).toEqual([]);

    const miss = await sw.asset('/desk/li/pair-1/missing');
    expect(miss?.status).toBe(404);
    expect(env.posted).toEqual([{ type: 'desk-fetch', path: 'li/missing' }]);
  });
});
