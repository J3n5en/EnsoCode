/**
 * Web Push Service Worker：桌面 main 直发的推送在此落地为系统通知。
 * 载荷只含通用文案 + sessionId（消息内容不出加密信道），点击通知
 * 聚焦已开窗口（postMessage 让 App 切会话）或带参新开。
 */

/** 与 packages/phone/src/launchSession.ts 同名：iOS 冷启动常丢掉 query */
const LAUNCH_SESSION_CACHE = 'enso-phone-launch';
const LAUNCH_SESSION_URL = '/__open-session';

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

/**
 * 远程桌面：/desk/r/<pairId>/<build>/<path> 是桌面 renderer 产物，/desk/li/<pairId>/<url> 是本地图片。
 * 资源都不在中继上，经 desk 壳页面持有的加密隧道向桌面取；renderer 产物按 build 分代缓存。
 */
const DESK_CACHE_PREFIX = 'enso-desk-';
const DESK_FETCH_TIMEOUT_MS = 120_000;

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
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin || event.request.method !== 'GET') return;
  const match = /^\/desk\/(r|li)\/([^/]+)\/(.+)$/.exec(url.pathname);
  if (!match) return;
  event.respondWith(deskFetch(url, match[1], decodeURIComponent(match[2]), match[3]));
});

async function deskFetch(url, kind, pairId, rest) {
  if (kind === 'li') return askDeskShell(pairId, `li/${rest}`);
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
  let payload = { title: 'EnsoCode', body: '', sessionId: '' };
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
    data: { sessionId: payload.sessionId },
  });
  const badge =
    (payload.title === '需要审批' || payload.title === '等待你的回答') &&
    typeof self.registration.setAppBadge === 'function'
      ? self.registration.setAppBadge(1).catch(() => {})
      : null;
  event.waitUntil(badge ? Promise.all([notify, badge]) : notify);
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const sessionId = event.notification.data?.sessionId || '';
  const target = sessionId ? `/?session=${encodeURIComponent(sessionId)}` : '/';
  event.waitUntil(
    (async () => {
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
