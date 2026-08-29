/**
 * Web Push Service Worker：桌面 main 直发的推送在此落地为系统通知。
 * 载荷只含通用文案 + sessionId（消息内容不出加密信道），点击通知
 * 聚焦已开窗口（postMessage 让 App 切会话）或带参新开。
 */

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('push', (event) => {
  let payload = { title: 'EnsoCode', body: '', sessionId: '' };
  try {
    payload = { ...payload, ...event.data.json() };
  } catch {
    // 载荷解析失败也要弹通知：iOS 要求每个 push 事件必须 showNotification
  }
  event.waitUntil(
    self.registration.showNotification(payload.title, {
      body: payload.body,
      icon: '/icons/icon-192.png',
      badge: '/icons/icon-192.png',
      tag: payload.sessionId || 'enso',
      data: { sessionId: payload.sessionId },
    })
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const sessionId = event.notification.data?.sessionId || '';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
      const existing = clients[0];
      if (existing) {
        existing.postMessage({ type: 'open-session', sessionId });
        return existing.focus();
      }
      return self.clients.openWindow(sessionId ? `/?session=${sessionId}` : '/');
    })
  );
});
