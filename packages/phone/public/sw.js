/**
 * Web Push Service Worker：桌面 main 直发的推送在此落地为系统通知。
 * 载荷只含通用文案 + sessionId（消息内容不出加密信道），点击通知
 * 聚焦已开窗口（postMessage 让 App 切会话）或带参新开。
 */

/** 与 packages/phone/src/launchSession.ts 同名：iOS 冷启动常丢掉 query */
const LAUNCH_SESSION_CACHE = 'enso-phone-launch';
const LAUNCH_SESSION_URL = '/__open-session';

/**
 * 页面壳预缓存：/、/desk 及 desk 入口的 JS/CSS。构建时由 vite.config 把这两行换成本次构建的版本与清单
 * （src/shellPrecache.ts）；开发模式清单为空，不接管导航。
 * 每个版本一份缓存，齐了才用；导航先出缓存（不等中继），新版装好后由页面在安全时机重载换上。
 */
const SHELL_VERSION = 'dev';
const SHELL_FILES = [];
const SHELL_CACHE_PREFIX = 'enso-shell-';
const SHELL_CACHE = `${SHELL_CACHE_PREFIX}${SHELL_VERSION}`;
const SHELL_COMPLETE = '/__shell-complete';
const SHELL_PAGES = { '/': '/', '/index.html': '/', '/desk': '/desk', '/desk.html': '/desk' };
/** iOS 偶发 Cache Storage 卡死（#320/#329）：查缓存超时就走网络，不能把页面挡在白屏 */
const SHELL_CACHE_TIMEOUT_MS = 1500;
/** 启动卡住重载前页面打的标记：这段时间内导航先走网络，避免再拿到同一份坏壳 */
const SHELL_FRESH_MS = 30_000;
const SHELL_FRESH_URL = '/__shell-fresh';
let freshUntil = 0;

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
  // 不放进 waitUntil：激活期间到来的请求会排队等它，首次启动不能为预缓存多等
  void ensureShell();
});

function withTimeout(task, ms, fallback) {
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

/** 只留内容和类型：带 redirected 标记或压缩头的响应原样回给导航会出错 */
async function plainResponse(response) {
  const headers = { 'Content-Type': response.headers.get('Content-Type') || 'text/html' };
  return new Response(await response.blob(), { status: 200, headers });
}

let precaching = null;

/** 中继不认识的路径会回退成 index.html（200）：页面须是本版本、脚本样式不能是 HTML，否则整套作废 */
async function sameBuild(path, response) {
  const type = response.headers.get('Content-Type') || '';
  if (!(path in SHELL_PAGES)) return !type.startsWith('text/html');
  const html = await response.clone().text();
  return html.includes(`<meta name="enso-shell" content="${SHELL_VERSION}"`);
}

/**
 * 当前版本的壳整套取齐后一次写入；不阻塞安装（首次启动不多等），由激活、页面消息或导航触发。
 * 中继已经换成别的版本时取到的对不上，就不写：导航照旧走网络，等新版 SW 来取。
 */
function ensureShell() {
  if (SHELL_FILES.length === 0) return Promise.resolve(false);
  if (precaching) return precaching;
  precaching = (async () => {
    const cache = await caches.open(SHELL_CACHE);
    if (await cache.match(SHELL_COMPLETE)) return true;
    const fetched = await Promise.all(
      SHELL_FILES.map(async (path) => {
        const response = await fetch(path, { cache: path in SHELL_PAGES ? 'no-cache' : 'default' });
        if (!response.ok) throw new Error(`${path}: ${response.status}`);
        if (!(await sameBuild(path, response))) throw new Error(`${path}: other build`);
        return [path, await plainResponse(response)];
      })
    );
    for (const [path, response] of fetched) await cache.put(path, response);
    await cache.put(SHELL_COMPLETE, new Response(SHELL_VERSION));
    await pruneShells();
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of windows) client.postMessage({ type: 'shell-ready' });
    return true;
  })()
    .catch(() => false)
    .finally(() => {
      precaching = null;
    });
  return precaching;
}

/** 旧版本只留上一个（离线时兜底、页面换新前还在用） */
async function pruneShells() {
  const names = (await caches.keys()).filter(
    (name) => name.startsWith(SHELL_CACHE_PREFIX) && name !== SHELL_CACHE
  );
  await Promise.all(names.slice(0, -1).map((name) => caches.delete(name)));
}

/** 兜底查找：当前版本（齐不齐都算）在前，其余旧版本新的在前 */
async function matchShell(key) {
  const names = (await caches.keys()).filter((name) => name.startsWith(SHELL_CACHE_PREFIX));
  const ordered = [SHELL_CACHE, ...names.filter((n) => n !== SHELL_CACHE).reverse()];
  for (const name of ordered) {
    if (!names.includes(name)) continue;
    const hit = await (await caches.open(name)).match(key);
    if (hit) return hit;
  }
  return undefined;
}

/** 冷启动热路径：只开当前版本一个缓存，三次查询并行（SW 每次冷启动都是新进程，内存标记靠不住） */
async function cachedPage(key) {
  const cache = await caches.open(SHELL_CACHE);
  const [complete, marker, hit] = await Promise.all([
    cache.match(SHELL_COMPLETE),
    Date.now() < freshUntil ? undefined : cache.match(SHELL_FRESH_URL),
    cache.match(key),
  ]);
  if (!complete || Date.now() < freshUntil) return undefined;
  if (marker && Date.now() - Number(await marker.text()) < SHELL_FRESH_MS) return undefined;
  return hit;
}

async function shellPage(event, key) {
  const hit = await withTimeout(cachedPage(key), SHELL_CACHE_TIMEOUT_MS, undefined);
  if (hit) return hit;
  try {
    const response = await fetch(event.request);
    event.waitUntil(ensureShell());
    return response;
  } catch (error) {
    // 没网或中继不可达：当前版本没齐就退回上一个版本
    const hit = await withTimeout(matchShell(key), SHELL_CACHE_TIMEOUT_MS, undefined);
    if (hit) return hit;
    throw error;
  }
}

/** /assets 下都带内容哈希：哪一代缓存里有都能用；精简版的包不预缓存，用过一次后留在当前版本里 */
async function shellAsset(event, url) {
  const key = `${url.origin}${url.pathname}`;
  const lookup = caches
    .open(SHELL_CACHE)
    .then((cache) => cache.match(key))
    .then((hit) => hit || matchShell(key));
  const hit = await withTimeout(lookup, SHELL_CACHE_TIMEOUT_MS, undefined);
  if (hit) return hit;
  const response = await fetch(event.request);
  const type = response.headers.get('Content-Type') || '';
  if (response.ok && response.type === 'basic' && !type.startsWith('text/html')) {
    const copy = response.clone();
    event.waitUntil(
      caches
        .open(SHELL_CACHE)
        .then((cache) => cache.put(key, copy))
        .catch(() => {})
    );
  }
  return response;
}

/**
 * 远程桌面：/desk/r/<pairId>/<build>/<path> 是桌面 renderer 产物，/desk/li/<pairId>/<url> 是本地图片。
 * 资源都不在中继上，经 desk 壳页面持有的加密隧道向桌面取；renderer 产物按 build 分代缓存。
 */
const DESK_CACHE_PREFIX = 'enso-desk-';
const REMOTE_IMAGE_CACHE = 'enso-remote-images';
const DESK_FETCH_TIMEOUT_MS = 120_000;

async function cachedDeskImage(url) {
  const lookup = caches
    .open(REMOTE_IMAGE_CACHE)
    .then(
      async (cache) =>
        (await cache.match(url.href)) || (await cache.match(`${url.pathname}${url.search}`))
    )
    .catch(() => undefined);
  return withTimeout(lookup, SHELL_CACHE_TIMEOUT_MS, undefined);
}

self.addEventListener('message', (event) => {
  if (event.data?.type === 'desk-ping') event.ports[0]?.postMessage({ desk: 1 });
  // 已激活却没接管发来消息的页面（注销后复活、强制刷新）：activate 不会再来，主动接管
  if (event.data?.type === 'desk-claim')
    event.waitUntil(
      self.clients
        .claim()
        .catch(() => {})
        .then(() => event.ports[0]?.postMessage({ desk: 1 }))
    );
  // 页面带上自己的壳版本来问：当前版本齐了、且页面是旧版本缓存出来的，才让它换新
  if (event.data?.type === 'shell-check') {
    const port = event.ports[0];
    const version = typeof event.data.version === 'string' ? event.data.version : '';
    event.waitUntil(
      ensureShell().then(async (ready) => {
        const stale =
          ready &&
          version !== '' &&
          version !== SHELL_VERSION &&
          (await caches.has(`${SHELL_CACHE_PREFIX}${version}`));
        port?.postMessage({ ready, stale, version: SHELL_VERSION });
      })
    );
  }
  if (event.data?.type === 'shell-fresh' && SHELL_FILES.length > 0) {
    freshUntil = Date.now() + SHELL_FRESH_MS;
    event.waitUntil(
      caches
        .open(SHELL_CACHE)
        .then((cache) => cache.put(SHELL_FRESH_URL, new Response(String(Date.now()))))
        .catch(() => {})
    );
  }
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin || event.request.method !== 'GET') return;
  if (SHELL_FILES.length > 0) {
    const page = SHELL_PAGES[url.pathname];
    if (page && event.request.mode === 'navigate') {
      event.respondWith(shellPage(event, page));
      return;
    }
    if (
      url.pathname.startsWith('/assets/') ||
      url.pathname === '/manifest.webmanifest' ||
      url.pathname.startsWith('/icons/')
    ) {
      event.respondWith(shellAsset(event, url));
      return;
    }
  }
  const match = /^\/desk\/(r|li)\/([^/]+)\/(.+)$/.exec(url.pathname);
  if (!match) return;
  event.respondWith(deskFetch(url, match[1], decodeURIComponent(match[2]), match[3]));
});

async function deskFetch(url, kind, pairId, rest) {
  if (kind === 'li') {
    const hit = await cachedDeskImage(url);
    if (hit?.ok) return hit;
    return askDeskShell(pairId, `li/${rest}`);
  }
  const slash = rest.indexOf('/');
  if (slash <= 0) return new Response('Not found', { status: 404 });
  const build = decodeURIComponent(rest.slice(0, slash));
  const path = rest.slice(slash + 1);
  const cache = await caches.open(`${DESK_CACHE_PREFIX}${build}`);
  const key = `${url.origin}${url.pathname}`;
  const hit = await cache.match(key);
  if (hit) return hit;
  const reused = await reuseFingerprinted(url, rest.slice(0, slash), path);
  if (reused) {
    await cache.put(key, reused.clone()).catch(() => {});
    return reused;
  }
  const response = await askDeskShell(pairId, `r/${path}`);
  if (response.status === 200) await cache.put(key, response.clone()).catch(() => {});
  return response;
}

/**
 * 桌面升级后大多数产物内容未变：文件名带内容指纹（name-<hash>.ext）的，可直接取旧构建缓存里的同名文件，
 * 不必再经中继重下（终端字体、语法包、mermaid 等动辄数 MB）。
 */
const FINGERPRINTED = /^assets\/[^/]+-[A-Za-z0-9_-]{8,}\.[a-z0-9]+$/;

async function reuseFingerprinted(url, rawBuild, path) {
  if (!FINGERPRINTED.test(path)) return undefined;
  const current = `${DESK_CACHE_PREFIX}${decodeURIComponent(rawBuild)}`;
  const names = (await caches.keys()).filter(
    (n) => n.startsWith(DESK_CACHE_PREFIX) && n !== current
  );
  const marker = `/${rawBuild}/`;
  const at = url.pathname.indexOf(marker);
  if (at < 0) return undefined;
  for (const name of names.reverse()) {
    const build = encodeURIComponent(name.slice(DESK_CACHE_PREFIX.length));
    const key = `${url.origin}${url.pathname.slice(0, at)}/${build}/${url.pathname.slice(at + marker.length)}`;
    const hit = await (await caches.open(name)).match(key);
    if (hit) return hit;
  }
  return undefined;
}

async function askDeskShell(pairId, path) {
  const windows = await self.clients.matchAll({ type: 'window' });
  const isShell = (client) => /^\/desk(\.html)?$/.test(new URL(client.url).pathname);
  const shell =
    windows.find((c) => isShell(c) && new URL(c.url).searchParams.get('device') === pairId) ||
    windows.find(isShell);
  if (!shell) return new Response('Desk shell is not open', { status: 503 });
  return new Promise((resolve) => {
    const channel = new MessageChannel();
    const timer = setTimeout(
      () => resolve(new Response('Timeout', { status: 504 })),
      DESK_FETCH_TIMEOUT_MS
    );
    channel.port1.onmessage = (event) => {
      clearTimeout(timer);
      const { status, mime, body } = event.data || {};
      resolve(
        new Response(status === 204 ? null : body, {
          status: status || 502,
          headers: { 'Content-Type': mime || 'application/octet-stream' },
        })
      );
    };
    shell.postMessage({ type: 'desk-fetch', path }, [channel.port2]);
  });
}

self.addEventListener('push', (event) => {
  let payload = { title: 'EnsoCode', body: '', sessionId: '', pending: false };
  try {
    payload = { ...payload, ...event.data.json() };
  } catch {
    // 载荷解析失败也要弹通知：iOS 要求每个 push 事件必须 showNotification
  }
  const notify = self.registration.showNotification(payload.title, {
    body: payload.body,
    icon: '/icons/icon-192.png',
    badge: '/icons/icon-192.png',
    tag: payload.sessionId || 'enso',
    data: { sessionId: payload.sessionId, pending: payload.pending === true },
  });
  // 角标数未处理的审批和提问（同 tag 的通知会合并，按现存通知计）
  const badge = notify.then(() => syncBadge());
  event.waitUntil(badge);
});

// 旧载荷没有 pending 字段：退回按标题文字匹配（含新格式「会话名 · 需要审批」）
const PENDING_TITLES = ['需要审批', '等待你的回答'];

function isPendingNotification(item) {
  if (item.data && typeof item.data.pending === 'boolean') return item.data.pending;
  return PENDING_TITLES.some((t) => item.title === t || item.title.endsWith(` · ${t}`));
}

function syncBadge() {
  if (typeof self.registration.setAppBadge !== 'function') return Promise.resolve();
  return self.registration.getNotifications().then((items) => {
    const n = items.filter(isPendingNotification).length;
    return n > 0 ? self.registration.setAppBadge(n) : self.registration.clearAppBadge?.();
  });
}

// 页面回到前台：用户已经看到待处理项，角标清零
self.addEventListener('message', (event) => {
  if (event.data?.type !== 'badge-clear') return;
  if (typeof self.registration.clearAppBadge === 'function')
    event.waitUntil(self.registration.clearAppBadge().catch(() => {}));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const sessionId = event.notification.data?.sessionId || '';
  const target = sessionId ? `/?session=${encodeURIComponent(sessionId)}` : '/';
  event.waitUntil(
    (async () => {
      await syncBadge();
      if (sessionId) {
        try {
          const cache = await caches.open(LAUNCH_SESSION_CACHE);
          await cache.put(
            LAUNCH_SESSION_URL,
            new Response(sessionId, { headers: { 'Content-Type': 'text/plain' } })
          );
        } catch {}
      }
      const windows = await self.clients.matchAll({
        type: 'window',
        includeUncontrolled: true,
      });
      // 完整版的 renderer / 快照是嵌套 iframe，把消息发给它们不会切会话
      const topLevel = windows.filter((client) => {
        if (client.frameType) return client.frameType === 'top-level';
        try {
          const url = new URL(client.url);
          return url.protocol !== 'about:' && !url.pathname.startsWith('/desk/');
        } catch {
          return false;
        }
      });
      const existing =
        topLevel.find((client) => client.focused) ||
        topLevel.find((client) => client.visibilityState === 'visible') ||
        topLevel[0];
      if (existing) {
        existing.postMessage({ type: 'open-session', sessionId });
        // 页面自己处理深链；留下的冷启动兜底会让下次打开又跳一次
        try {
          const cache = await caches.open(LAUNCH_SESSION_CACHE);
          await cache.delete(LAUNCH_SESSION_URL);
        } catch {}
        return existing.focus();
      }
      return self.clients.openWindow(target);
    })()
  );
});
