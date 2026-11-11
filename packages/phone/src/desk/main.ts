import { normalizeRelayUrl } from '@enso/pair';
import type { RemoteBridge, RemoteFrameKind } from '@shared/remoteBridge';
import { IPC_CHANNELS } from '@shared/types/ipc';
import type { ConnState } from '../client';
import { pickActive } from '../deviceList';
import { parseSessionFromSearch, parseSessionId, takeStashedSessionId } from '../launchSession';
import { PHONE_PUSH_ENABLED_KEY, pushAvailability, subscribePush, unsubscribePush } from '../push';
import { loadActiveDeviceId, loadDevices, saveActiveDeviceId } from '../storage';
import { PHONE_URL, saveUiMode } from '../uiMode';
import { RelayBundle } from './bundle';
import { watchDeskChrome } from './chrome';
import {
  buildReady,
  type DeskMeta,
  deskBase,
  downloadProgress,
  loadDeskMeta,
  markBuildReady,
  saveDeskMeta,
} from './launch';
import { installLeaveGuard } from './leaveGuard';
import {
  initialDeskLink,
  parsePushPending,
  parseRemotePushSubscription,
  reduceDeskLink,
  toRemoteLinkStatus,
} from './linkModel';
import {
  createSnapshotTracker,
  loadReads,
  loadSnapshot,
  mountSnapshot,
  pruneSnapshots,
  saveReads,
  saveSnapshot,
} from './snapshot';
import { type DeskAsset, type DeskFrame, DeskTunnel } from './tunnel';

const DESK_CACHE_PREFIX = 'enso-desk-';
const META_TIMEOUT_MS = 25_000;

const $ = (id: string) => document.getElementById(id) as HTMLElement;

/** 已判定无法使用（旧桌面/只读）：后续连接状态、超时提示不再覆盖结论 */
let stopped = false;
/** 界面在用时关闭/后退要二次确认；出错页只剩跳转链接，不再拦 */
let leaveGuard: { release(): void } | null = null;

function splash(html: string): void {
  if (stopped) return;
  leaveGuard?.release();
  loading = false;
  $('frames').style.visibility = 'hidden';
  $('splash').style.display = 'flex';
  $('splash-text').innerHTML = html;
}

/** 启动进度：只在仍处于加载阶段时更新，不覆盖错误结论 */
let loading = true;
function progress(text: string): void {
  if (!loading || stopped) return;
  $('splash-text').textContent = text;
}

function revealFrames(): void {
  loading = false;
  $('splash').style.display = 'none';
  $('frames').style.visibility = 'visible';
  renderStatus();
}

/** 回退手机版：记住的模式改回 phone，下次启动不再跳进来 */
function fallback(html: string): void {
  saveUiMode('phone');
  splash(`${html}<a href="${PHONE_URL}">返回精简版</a>`);
  stopped = true;
}

const STATE_TEXT: Record<ConnState, string> = {
  connecting: '连接中…',
  online: '',
  'host-offline': '桌面不在线',
  offline: '已断开，正在重连…',
  unauthorized: '配对已失效',
  replaced: '已在其他页面打开',
};

const LOADING_TEXT: Partial<Record<ConnState, string>> = {
  connecting: '正在连接中继…',
  online: '正在等待桌面响应…',
  'host-offline': '桌面不在线，等它上线后自动连接…',
  offline: '网络已断开，正在重连…',
};

/** 正盖着上次的界面快照：在线时提示还在同步、暂不能操作 */
let syncing = false;
let lastState: ConnState = 'connecting';

function renderStatus(): void {
  const el = $('status');
  const text = lastState === 'online' ? (syncing ? '正在同步…' : '') : STATE_TEXT[lastState];
  el.textContent = text;
  // 启动画面已在说明进度时不再叠一个状态胶囊
  el.style.display = text && !loading ? 'block' : 'none';
}

function showState(state: ConnState): void {
  lastState = state;
  renderStatus();
  const text = LOADING_TEXT[state];
  if (text) progress(text);
  if (state === 'unauthorized')
    splash(`配对已失效，请回到<a href="${PHONE_URL}">精简版</a>重新配对。`);
  if (state === 'replaced')
    splash(`已在其他页面打开，关掉那个页面或回到<a href="${PHONE_URL}">精简版</a>重连。`);
}

/** SW 需要能代理 /desk/* ：旧版 SW 没有 fetch 处理，先确保新版接管本页 */
async function ensureDeskWorker(): Promise<void> {
  const registration = await navigator.serviceWorker.register('/sw.js');
  const ping = () =>
    new Promise<boolean>((resolve) => {
      const controller = navigator.serviceWorker.controller;
      if (!controller) {
        resolve(false);
        return;
      }
      const channel = new MessageChannel();
      const timer = setTimeout(() => resolve(false), 1500);
      channel.port1.onmessage = (event) => {
        clearTimeout(timer);
        resolve(event.data?.desk === 1);
      };
      controller.postMessage({ type: 'desk-ping' }, [channel.port2]);
    });
  for (let attempt = 0; attempt < 4; attempt++) {
    if (await ping()) return;
    await registration.update().catch(() => {});
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 3000);
      navigator.serviceWorker.addEventListener(
        'controllerchange',
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true }
      );
    });
  }
  throw new Error('service worker unavailable');
}

async function main(): Promise<void> {
  if (!('serviceWorker' in navigator)) {
    splash('当前浏览器不支持 Service Worker，无法使用完整版。');
    return;
  }
  const params = new URLSearchParams(location.search);
  const devices = loadDevices();
  const device =
    devices.find((d) => d.pairId === params.get('device')) ??
    pickActive(devices, loadActiveDeviceId());
  if (!device) {
    fallback('还没有配对的电脑，请先在精简版完成配对。');
    return;
  }
  if (device.scope === 'read') {
    fallback('该设备在桌面端被设为只读，无法使用完整版。');
    return;
  }
  // 记住桌面模式与所用设备：下次从主屏打开直接回到这里
  saveUiMode('desk');
  saveActiveDeviceId(device.pairId);
  const urlSession = parseSessionFromSearch(location.search);
  if (params.has('session')) params.delete('session');
  if (params.get('device') !== device.pairId) {
    params.set('device', device.pairId);
  }
  if (`?${params}` !== location.search) {
    history.replaceState(null, '', `${location.pathname}?${params}`);
  }
  // iOS 冷启动常丢掉 openWindow 的 query，会话 id 在 SW 写入的 Cache 里
  const launchSessionId = urlSession ?? (await takeStashedSessionId());

  await ensureDeskWorker();

  const frames = $('frames');
  const iframes: Partial<Record<RemoteFrameKind, HTMLIFrameElement>> = {};
  const attached: Partial<Record<RemoteFrameKind, DeskFrame>> = {};
  let base = '';
  let version = '';
  let settingsLink: unknown = null;
  let settingsLoaded = false;
  let snapshot: HTMLIFrameElement | null = null;
  let snapshotTimer: ReturnType<typeof setInterval> | null = null;

  let link = initialDeskLink(device.label, localStorage.getItem(PHONE_PUSH_ENABLED_KEY) === 'on');
  const linkListeners = new Set<(status: ReturnType<typeof toRemoteLinkStatus>) => void>();
  const publishLink = (next: typeof link) => {
    if (next === link) return;
    link = next;
    const status = toRemoteLinkStatus(link, pushAvailability());
    for (const listener of linkListeners) listener(status);
  };

  let tunnel!: DeskTunnel;
  tunnel = new DeskTunnel(
    device,
    (state) => {
      showState(state);
      publishLink(reduceDeskLink(link, { type: 'state', state }));
    },
    (error) => {
      if (error === 'host-outdated') fallback('桌面端版本过旧，不支持完整版，请升级后再试。');
      else if (error === 'read-only') fallback('该设备在桌面端被设为只读，无法使用完整版。');
      else if (error === 'renderer-missing')
        splash('桌面端缺少浏览器版资源，请更新或重新构建桌面版。');
      else splash(`桌面拒绝连接：${error}`);
    },
    {
      onTransport: (transport) =>
        publishLink(reduceDeskLink(link, { type: 'transport', transport })),
      onRtt: (rttMs) => publishLink(reduceDeskLink(link, { type: 'rtt', rttMs })),
      onPushConfig: (key) => {
        publishLink(reduceDeskLink(link, { type: 'push-config', key }));
        if (localStorage.getItem(PHONE_PUSH_ENABLED_KEY) !== 'on') return;
        // 已经允许过：刷新订阅不需要再弹权限
        void subscribePush(key).then((result) => {
          if (result.ok)
            tunnel.sendGuest({ type: 'push-subscribe', subscription: result.subscription });
        });
      },
    }
  );

  const mount = (kind: RemoteFrameKind): HTMLIFrameElement => {
    const iframe = document.createElement('iframe');
    iframe.className = kind;
    iframe.allow = 'clipboard-read; clipboard-write; microphone';
    iframe.src = `${base}/${kind === 'main' ? 'index' : 'settings'}.html`;
    if (kind === 'settings') {
      const backdrop = document.createElement('div');
      backdrop.className = 'settings-backdrop';
      backdrop.addEventListener('click', () => closeSettings());
      frames.appendChild(backdrop);
    }
    frames.appendChild(iframe);
    iframes[kind] = iframe;
    return iframe;
  };

  const closeSettings = () => {
    iframes.settings?.remove();
    delete iframes.settings;
    frames.querySelector('.settings-backdrop')?.remove();
  };

  const bridge: RemoteBridge = {
    platform: 'linux',
    attach(kind) {
      const frame = tunnel.attach(kind, () => {
        const iframe = iframes[kind];
        if (kind === 'main') {
          void (async () => {
            await keepSnapshot();
            settingsLoaded = false;
            await coverWithSnapshot();
            if (iframes.main === iframe) iframe?.contentWindow?.location.reload();
          })();
          return;
        }
        iframe?.contentWindow?.location.reload();
      });
      attached[kind] = frame;
      return {
        invoke:
          kind === 'main'
            ? (channel, payload) => {
                const result = frame.invoke(channel, payload);
                if (channel === IPC_CHANNELS.SETTINGS_READ)
                  void result.then(() => {
                    if (!settingsLoaded) void markReady(version);
                    settingsLoaded = true;
                  });
                return result;
              }
            : frame.invoke,
        send: frame.send,
        on: frame.on,
        close: () => {
          frame.close();
          if (attached[kind] === frame) delete attached[kind];
        },
      };
    },
    leader: () => tunnel.leader,
    openSettings(link) {
      settingsLink = link ?? null;
      if (iframes.settings) {
        if (link) attached.settings?.emit(IPC_CHANNELS.SETTINGS_DEEP_LINK, [link]);
        return;
      }
      mount('settings');
    },
    closeSettings,
    consumeSettingsLink() {
      const link = settingsLink;
      settingsLink = null;
      return link;
    },
    exitDesk() {
      leaveGuard?.release();
      location.href = PHONE_URL;
    },
    linkStatus: () => toRemoteLinkStatus(link, pushAvailability()),
    onLinkStatus(callback) {
      linkListeners.add(callback);
      return () => linkListeners.delete(callback);
    },
    vapidPublicKey: () => link.vapidPublicKey,
    setPushSubscription(subscription) {
      if (subscription === null) {
        tunnel.sendGuest({ type: 'push-unsubscribe' });
        localStorage.setItem(PHONE_PUSH_ENABLED_KEY, 'off');
        publishLink(
          reduceDeskLink(link, { type: 'push', enabled: false, busy: false, error: null })
        );
        void unsubscribePush();
        return;
      }
      const parsed = parseRemotePushSubscription(subscription);
      if (!parsed) return;
      tunnel.sendGuest({ type: 'push-subscribe', subscription: parsed });
      localStorage.setItem(PHONE_PUSH_ENABLED_KEY, 'on');
      publishLink(reduceDeskLink(link, { type: 'push', enabled: true, busy: false, error: null }));
    },
    setPushPending(pending) {
      const parsed = parsePushPending(pending);
      if (!parsed) return;
      publishLink(reduceDeskLink(link, { type: 'push', ...parsed }));
    },
  };
  (window as Window & { __ensoRemote?: RemoteBridge }).__ensoRemote = bridge;
  // 后退先关设置层，其余情况确认后才离开
  leaveGuard = installLeaveGuard(window, '确定离开 EnsoCode 完整版？', () => {
    if (!iframes.settings) return false;
    closeSettings();
    return true;
  });

  /**
   * 会话目录要等连上桌面才有，iframe 还没 attach 或目录未到时发一次会丢。
   * 重复选择会重走 authority，所以帧就绪后只发三次。
   */
  let focusGen = 0;
  const focusSession = (sessionId: string) => {
    const gen = ++focusGen;
    const started = Date.now();
    let sent = 0;
    const tick = () => {
      if (gen !== focusGen) return;
      if (!attached.main) {
        if (Date.now() - started < 60_000) window.setTimeout(tick, 500);
        return;
      }
      attached.main.emit(IPC_CHANNELS.NOTIFICATION_FOCUS_SESSION, [sessionId]);
      sent += 1;
      if (sent < 3) window.setTimeout(tick, sent === 1 ? 1000 : 3000);
    };
    tick();
  };
  if (launchSessionId) focusSession(launchSessionId);

  /** 电脑报来的清单 id 与中继内置的一致时，renderer 产物直接从中继取（按清单校验） */
  let relay: RelayBundle | null = null;
  const fetchDeskAsset = async (path: string): Promise<DeskAsset> => {
    if (relay && path.startsWith('r/')) {
      let file = '';
      try {
        file = decodeURIComponent(path.slice(2));
      } catch {}
      const hit = file ? await relay.get(file) : null;
      if (hit) return hit;
    }
    return tunnel.fetchAsset(path);
  };

  navigator.serviceWorker.addEventListener('message', (event) => {
    const data = event.data as { type?: unknown; path?: unknown; sessionId?: unknown } | null;
    if (data?.type === 'open-session') {
      const sessionId = parseSessionId(data.sessionId);
      if (sessionId) focusSession(sessionId);
      return;
    }
    const port = event.ports[0];
    if (data?.type !== 'desk-fetch' || typeof data.path !== 'string' || !port) return;
    void fetchDeskAsset(data.path).then((asset) => {
      const body = asset.body.slice().buffer;
      port.postMessage({ status: asset.status, mime: asset.mime, body }, [body]);
    });
  });

  /** 某个构建曾完整起来过（资源都在 SW 缓存里）：可以不等宿主，直接起 renderer */
  const cachedBuild = async (meta: DeskMeta): Promise<boolean> => {
    try {
      const cache = await caches.open(`${DESK_CACHE_PREFIX}${meta.version}`);
      return await buildReady(cache, location.origin, deskBase(device.pairId, meta.version));
    } catch {
      return false;
    }
  };

  const markReady = async (build: string): Promise<void> => {
    if (!build) return;
    try {
      const cache = await caches.open(`${DESK_CACHE_PREFIX}${build}`);
      await markBuildReady(cache, location.origin, deskBase(device.pairId, build));
    } catch {}
  };

  const use = (meta: DeskMeta): void => {
    bridge.platform = meta.platform;
    base = deskBase(device.pairId, meta.version);
    version = meta.version;
  };

  const liveChars = () => iframes.main?.contentDocument?.body?.textContent?.length ?? 0;

  const dropSnapshot = (): void => {
    if (snapshotTimer) {
      clearInterval(snapshotTimer);
      snapshotTimer = null;
    }
    const el = snapshot;
    snapshot = null;
    syncing = false;
    renderStatus();
    if (!el) return;
    el.style.opacity = '0';
    setTimeout(() => el.remove(), 200);
  };

  /** 先盖上次的界面，renderer 拿到设置且内容基本追上（或稳定下来）再揭开 */
  const coverWithSnapshot = async (): Promise<void> => {
    const saved = await loadSnapshot(`${DESK_CACHE_PREFIX}${version}`, base);
    if (!saved || !iframes.main) return;
    if (snapshotTimer) {
      clearInterval(snapshotTimer);
      snapshotTimer = null;
    }
    if (!snapshot) {
      const mounted = mountSnapshot(frames, saved.html);
      snapshot = mounted;
      await new Promise<void>((resolve) => {
        const done = () => {
          clearTimeout(fallbackTimer);
          resolve();
        };
        const fallbackTimer = setTimeout(done, 150);
        mounted.addEventListener('load', done, { once: true });
      });
    }
    syncing = true;
    renderStatus();
    const step = createSnapshotTracker(Date.now(), saved.chars);
    snapshotTimer = setInterval(() => {
      if (!snapshot) {
        if (snapshotTimer) clearInterval(snapshotTimer);
        snapshotTimer = null;
        return;
      }
      const ready = step({
        now: Date.now(),
        liveChars: liveChars(),
        settingsLoaded,
        liveLoading: Boolean(
          iframes.main?.contentDocument?.querySelector('[data-timeline-loading]')
        ),
      });
      if (!ready) return;
      dropSnapshot();
    }, 200);
  };

  /** 只读结果缓存（shim 从父页面取用）：重启 PWA 后带 hash 询问，没变就不用重下设置和历史 */
  const reads = new Map<string, { h: string; json: string }>();
  (window as Window & { __ensoRemoteReads?: unknown }).__ensoRemoteReads = reads;

  /** 切后台/离开时存一份当前界面和只读缓存，下次启动先显示它 */
  const keepSnapshot = async (): Promise<void> => {
    if (!version) return;
    void saveReads(`${DESK_CACHE_PREFIX}${version}`, base, reads).catch(() => {});
    const doc = iframes.main?.contentDocument;
    if (snapshot || !settingsLoaded || !doc) return;
    await saveSnapshot(`${DESK_CACHE_PREFIX}${version}`, base, doc).catch(() => {});
  };
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') void keepSnapshot();
  });
  window.addEventListener('pagehide', () => void keepSnapshot());
  setInterval(() => {
    if (document.visibilityState === 'visible') void keepSnapshot();
  }, 60_000);

  /** 首次（或桌面升级后）要经隧道下载整套界面：盖着启动画面并报进度，iframe 加载完再露出 */
  const mountFresh = (total?: number): void => {
    const iframe = mount('main');
    const started = tunnel.downloadedBytes;
    const timer = setInterval(() => {
      // 中继给的是原始字节，与按隧道帧估的总量不同口径：走了中继就只显示已下载
      const fromRelay = relay?.bytes ?? 0;
      const done = tunnel.downloadedBytes - started + fromRelay;
      progress(
        `正在下载完整版界面（首次或桌面端升级后需要）… ${downloadProgress(done, fromRelay ? undefined : total)}`
      );
    }, 500);
    iframe.addEventListener(
      'load',
      () => {
        clearInterval(timer);
        revealFrames();
      },
      { once: true }
    );
  };

  tunnel.start();
  const cached = loadDeskMeta(localStorage, device.pairId);
  if (cached) {
    const saved = await loadReads(
      `${DESK_CACHE_PREFIX}${cached.version}`,
      deskBase(device.pairId, cached.version)
    );
    for (const [key, entry] of saved) reads.set(key, entry);
  }
  const launched = cached !== null && (await cachedBuild(cached));
  if (launched) {
    use(cached);
    mount('main');
    await coverWithSnapshot();
    revealFrames();
  }
  // 设置是弹窗时不铺满，状态栏 / 安全区底色仍跟主界面
  const settingsModal = matchMedia('(min-width: 800px) and (min-height: 560px)');
  watchDeskChrome(() => (settingsModal.matches ? undefined : iframes.settings) ?? iframes.main);

  const timeout = launched
    ? undefined
    : setTimeout(
        () => splash('连接桌面超时：桌面可能不在线，或版本过旧不支持完整版。'),
        META_TIMEOUT_MS
      );
  const meta = await tunnel.fetchAsset('meta');
  clearTimeout(timeout);
  let info: Partial<DeskMeta> & { download?: unknown; bundle?: unknown } = {};
  try {
    info = JSON.parse(new TextDecoder().decode(meta.body));
  } catch {}
  if (meta.status !== 200 || !info.version) {
    splash('桌面端缺少浏览器版资源，请更新或重新构建桌面版。');
    return;
  }
  const current: DeskMeta = { version: info.version, platform: info.platform ?? 'linux' };
  const download =
    typeof info.download === 'number' && info.download > 0 ? info.download : undefined;
  if (typeof info.bundle === 'string' && /^[0-9a-f]{64}$/.test(info.bundle))
    relay = new RelayBundle(normalizeRelayUrl(device.relayUrl), info.bundle);
  saveDeskMeta(localStorage, device.pairId, current);
  void pruneSnapshots(
    `${DESK_CACHE_PREFIX}${current.version}`,
    devices.map((d) => d.pairId)
  );

  // 上一次启动的构建保留到下次：升级时 SW 从中复用内容未变的带指纹文件
  const keep = new Set([current.version, cached?.version].map((v) => `${DESK_CACHE_PREFIX}${v}`));
  void caches
    .keys()
    .then((keys) =>
      Promise.all(
        keys
          .filter((k) => k.startsWith(DESK_CACHE_PREFIX) && !keep.has(k))
          .map((k) => caches.delete(k))
      )
    )
    .catch(() => {});

  if (launched && cached.version === current.version) return;
  // 桌面已升级（或首次）：换到新构建，旧构建的快照也不再适用
  use(current);
  dropSnapshot();
  settingsLoaded = false;
  closeSettings();
  iframes.main?.remove();
  delete iframes.main;
  if (await cachedBuild(current)) {
    mount('main');
    revealFrames();
    return;
  }
  loading = true;
  $('splash').style.display = 'flex';
  $('frames').style.visibility = 'hidden';
  mountFresh(download);
}

void main().catch((error) => splash(`启动失败：${error instanceof Error ? error.message : error}`));
