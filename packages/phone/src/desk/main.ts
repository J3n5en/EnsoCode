import { normalizeRelayUrl } from '@enso/pair';
import type { RemoteBridge, RemoteFrameKind } from '@shared/remoteBridge';
import { collectPrefetchItems } from '@shared/remoteDelta';
import {
  cachedRemoteImage,
  pruneRemoteImages,
  rehydrateImages,
  snapshotImage,
  storeRemoteImage,
} from '@shared/remoteImageCache';
import { IPC_CHANNELS } from '@shared/types/ipc';
import type { ConnState } from '../client';
import { pickActive } from '../deviceList';
import { installKeyboardInset } from '../keyboard';
import { parseSessionFromSearch, parseSessionId, takeStashedSessionId } from '../launchSession';
import {
  hasNativeDeskProxy,
  hasNativePip,
  hasNativePush,
  type NativePipAspect,
  type NativePipStatus,
  pushNativePipState,
  pushNativeWidgetState,
  registerNativeDeskFetcher,
  resolveNativePushGatewayOrigin,
  setNativePipAspect,
  setNativePipAuto,
  startNativePip,
  stopNativePip,
  subscribeNativePipState,
} from '../nativeBridge';
import {
  createTrailingThrottle,
  DeskPipTracker,
  loadNativePipAspect,
  loadNativePipAuto,
  loadNativePipFollow,
  type NativePipFollowMode,
  parseInvokeSessionId,
  saveNativePipAspect,
  saveNativePipAuto,
  saveNativePipFollow,
} from '../pipState';
import {
  isStandalone,
  PHONE_PUSH_ENABLED_KEY,
  pushAvailability,
  setNativePushGatewayResolver,
  subscribePush,
} from '../push';
import { acceptPushSubscription, pushDeps, turnPushOff, turnPushOn } from '../pushToggle';
import { watchShellUpdate } from '../shellUpdate';
import { loadActiveDeviceId, loadDevices, saveActiveDeviceId } from '../storage';
import { hadPairing, requestPersistence, storageLossNotice, syncPairedMark } from '../storageGuard';
import { PHONE_URL, saveUiMode } from '../uiMode';
import { DeskWidgetTracker } from '../widgetState';
import { RelayBundle } from './bundle';
import { watchDeskChrome } from './chrome';
import { createDeviceDrawer, DESKTOP_DRAWER_QUERY } from './deviceDrawer';
import { createDeskDevices, toggleDeskPush } from './devices';
import { formatDiagnostics } from './diagnostics';
import { themeOfFrame, watchFrameTheme } from './drawerTheme';
import {
  buildReady,
  clearBootRetry,
  clearDeskMeta,
  type DeskMeta,
  deskBase,
  downloadProgress,
  handleBootStuck,
  loadDeskMeta,
  markBuildReady,
  saveDeskMeta,
  upgradedBuild,
  withTimeout,
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
  offlineSnapshotNote,
  pruneSnapshots,
  saveReads,
  saveSnapshot,
} from './snapshot';
import { type DeskAsset, type DeskFrame, DeskTunnel } from './tunnel';
import { ensureDeskWorker } from './worker';

const DESK_CACHE_PREFIX = 'enso-desk-';
const META_TIMEOUT_MS = 25_000;
/** 启动阶段的单次存储调用上限：超时就当没缓存，照常连桌面 */
const STORAGE_TIMEOUT_MS = 1500;
/** 迟迟连不上隧道（多为 iOS SW / 存储卡死）就自动整页重载一次 */
const BOOT_STUCK_MS = 10_000;

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
function fallback(html: string, link = '返回精简版'): void {
  saveUiMode('phone');
  splash(`${html}<a href="${PHONE_URL}">${link}</a>`);
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
/** 盖着的快照是什么时候存的（旧快照没有记录） */
let coverSavedAt: number | null = null;
/** 已在线但 renderer 还没续上（回前台换链后）：别让界面看着像卡死 */
let resuming = false;
let lastState: ConnState = 'connecting';

function renderStatus(): void {
  const el = $('status');
  const text =
    lastState === 'online'
      ? syncing
        ? '正在同步…'
        : resuming
          ? '正在恢复连接…'
          : ''
      : STATE_TEXT[lastState];
  // 盖着快照却连不上（桌面不在线，或手机没网、壳是从缓存起来的）：写明显示的是什么时候的内容
  const away =
    lastState === 'host-offline' ? '桌面不在线' : lastState === 'offline' ? '网络未连接' : null;
  const shown = away && syncing ? offlineSnapshotNote(coverSavedAt, new Date(), away) : text;
  el.textContent = shown;
  // 启动画面已在说明进度时不再叠一个状态胶囊
  el.style.display = shown && !loading ? 'block' : 'none';
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

async function main(): Promise<void> {
  (window as { __deskBoot?: boolean }).__deskBoot = true;
  const nativeDeskProxy = hasNativeDeskProxy();
  if (!nativeDeskProxy && !('serviceWorker' in navigator)) {
    splash('当前浏览器不支持 Service Worker，无法使用完整版。');
    return;
  }
  const params = new URLSearchParams(location.search);
  const devices = loadDevices();
  const device =
    devices.find((d) => d.pairId === params.get('device')) ??
    pickActive(devices, loadActiveDeviceId());
  if (!device) {
    const lost = storageLossNotice({
      paired: false,
      marked: await withTimeout(hadPairing(), STORAGE_TIMEOUT_MS, false),
      standalone: isStandalone(),
    });
    if (lost) fallback(lost, '重新配对');
    else fallback('还没有配对的电脑，请先在精简版完成配对。');
    return;
  }
  if (device.scope === 'read') {
    fallback('该设备在桌面端被设为只读，无法使用完整版。');
    return;
  }
  // 记住桌面模式与所用设备：下次从主屏打开直接回到这里
  saveUiMode('desk');
  saveActiveDeviceId(device.pairId);
  void requestPersistence();
  void syncPairedMark(true);
  const urlSession = parseSessionFromSearch(location.search);
  if (params.has('session')) params.delete('session');
  if (params.get('device') !== device.pairId) {
    params.set('device', device.pairId);
  }
  if (`?${params}` !== location.search) {
    history.replaceState(null, '', `${location.pathname}?${params}`);
  }
  let bootStage = '读取启动会话';
  const bootWatchdog = setTimeout(() => {
    handleBootStuck(bootStage, {
      storage: sessionStorage,
      show: splash,
      reload: () => {
        // 重载这一次先走网络取壳：万一是缓存的壳本身有问题，别再拿到同一份
        navigator.serviceWorker.controller?.postMessage({ type: 'shell-fresh' });
        location.reload();
      },
      later: (fn, ms) => setTimeout(fn, ms),
    });
  }, BOOT_STUCK_MS);
  // iOS 冷启动常丢掉 openWindow 的 query，会话 id 在 SW 写入的 Cache 里
  const launchSessionId =
    urlSession ?? (await withTimeout(takeStashedSessionId(), STORAGE_TIMEOUT_MS, null));

  if (!nativeDeskProxy) {
    await ensureDeskWorker(navigator.serviceWorker, (stage) => {
      bootStage = stage;
    });
  }
  bootStage = '启动隧道';

  const frames = $('frames');
  // iframe 里的焦点事件不冒泡到壳：每次 iframe（重新）加载都挂一遍
  const keyboard = installKeyboardInset(window);
  const iframes: Partial<Record<RemoteFrameKind, HTMLIFrameElement>> = {};
  const attached: Partial<Record<RemoteFrameKind, DeskFrame>> = {};
  let base = '';
  let version = '';
  /** 换构建整页重载中：旧构建的快照和只读缓存不再有用，别在离开时写存储 */
  let leaving = false;
  let settingsLoaded = false;
  let optimisticHydrated = false;
  let snapshot: HTMLIFrameElement | null = null;
  let snapshotTimer: ReturnType<typeof setInterval> | null = null;
  let snapshotBlobs: string[] = [];

  // 壳是旧版本缓存出来的：renderer 还没起来就立即换新（旧壳配新桌面起不来时自愈），否则等回前台
  if (!nativeDeskProxy && 'serviceWorker' in navigator) {
    watchShellUpdate({
      container: navigator.serviceWorker,
      doc: document,
      storage: sessionStorage,
      canReloadNow: () => !settingsLoaded && !stopped,
      reload: () => {
        leaveGuard?.release();
        location.reload();
      },
    });
  }

  /** 只读结果缓存（shim 从父页面取用）：重启 PWA 后带 hash 询问，没变就不用重下设置和历史 */
  const reads = new Map<string, { h: string; json: string }>();
  const readsSignature = (map: Map<string, { h: string; json: string }>): string =>
    [...map.entries()]
      .map(([k, v]) => `${k}\0${v.h}`)
      .sort()
      .join('\n');
  let savedReadsSig = '';
  (window as Window & { __ensoRemoteReads?: unknown }).__ensoRemoteReads = reads;

  let link = initialDeskLink(device.label, localStorage.getItem(PHONE_PUSH_ENABLED_KEY) === 'on');
  const linkListeners = new Set<(status: ReturnType<typeof toRemoteLinkStatus>) => void>();
  const deskWidget = new DeskWidgetTracker();
  /** 画中画只在 iOS 原生壳里有：浏览器 / PWA 不建追踪器，事件流零额外开销 */
  const deskPip = hasNativePip() ? new DeskPipTracker() : null;
  const currentPipTheme = (): 'dark' | 'light' => {
    const frameTheme = themeOfFrame(iframes.main);
    if (frameTheme) return frameTheme.dark ? 'dark' : 'light';
    return matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  };
  const pipSync = createTrailingThrottle(() => {
    if (!deskPip) return;
    pushNativePipState(
      deskPip.buildSnapshot({
        deviceLabel: link.deviceLabel,
        connectionState: link.state,
        theme: currentPipTheme(),
      })
    );
  });
  const schedulePipSync = () => {
    if (deskPip) pipSync.schedule();
  };
  const syncNativeDeskWidget = (ingestReads = false) => {
    if (ingestReads) {
      const settingsJson = reads.get(`${IPC_CHANNELS.SETTINGS_READ}\0[]`)?.json;
      const authorityJson = reads.get(`${IPC_CHANNELS.SOURCE_AUTHORITY_READ}\0[]`)?.json;
      const conversationsJson = reads.get(`${IPC_CHANNELS.CONVERSATIONS_READ}\0[]`)?.json;
      for (const tracker of deskPip ? [deskWidget, deskPip] : [deskWidget]) {
        tracker.ingestSettingsJson(settingsJson);
        tracker.ingestSourceAuthorityJson(authorityJson);
        tracker.ingestConversationsJson(conversationsJson);
      }
    }
    pushNativeWidgetState(
      deskWidget.buildSnapshot({
        deviceLabel: link.deviceLabel,
        connectionState: link.state,
        transport: link.transport ?? '',
        rttMs: link.rttMs,
      })
    );
    schedulePipSync();
  };
  const publishLink = (next: typeof link) => {
    if (next === link) return;
    link = next;
    const status = toRemoteLinkStatus(link, pushAvailability());
    for (const listener of linkListeners) listener(status);
    syncNativeDeskWidget();
  };

  let pipStatus: NativePipStatus = {
    supported: true,
    active: false,
    auto: loadNativePipAuto(localStorage),
    aspect: loadNativePipAspect(localStorage),
  };
  let pipFollow: NativePipFollowMode = loadNativePipFollow(localStorage);
  const pipListeners = new Set<() => void>();
  const publishPip = (next: NativePipStatus) => {
    pipStatus = next;
    for (const listener of pipListeners) listener();
  };
  if (deskPip) {
    deskPip.setFollowMode(pipFollow);
    setNativePipAuto(pipStatus.auto);
    setNativePipAspect(pipStatus.aspect ?? 'portrait');
    subscribeNativePipState(publishPip);
  }

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
      onResuming: (active) => {
        resuming = active;
        renderStatus();
      },
      onBuild: (reported, platform) => {
        const next = upgradedBuild(version, reported, platform);
        if (!next) return false;
        // 旧构建的懒加载资源在新桌面上已不存在，只重载 iframe 会卡住：整页走启动时的升级流程
        saveDeskMeta(localStorage, device.pairId, next);
        leaving = true;
        leaveGuard?.release();
        location.reload();
        return true;
      },
      getPrefetch: () => collectPrefetchItems(reads),
      onPushConfig: (key) => {
        publishLink(reduceDeskLink(link, { type: 'push-config', key }));
        if (hasNativePush()) {
          setNativePushGatewayResolver(() => resolveNativePushGatewayOrigin(device.relayUrl));
        }
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
    iframe.allow = 'clipboard-read; clipboard-write';
    iframe.src = `${base}/index.html`;
    iframe.addEventListener('load', () => {
      const doc = iframe.contentDocument;
      if (doc) keyboard?.watchDocument(doc);
    });
    frames.appendChild(iframe);
    iframes[kind] = iframe;
    return iframe;
  };

  const push = pushDeps((message) => tunnel.sendGuest(message));
  const navigate = (url: string) => {
    leaveGuard?.release();
    location.replace(url);
  };
  const drawer = createDeviceDrawer({
    doc: document,
    currentId: device.pairId,
    devices: createDeskDevices({
      currentId: device.pairId,
      load: loadDevices,
      navigate,
      saveUiMode,
      onCurrentLabel: (label) => publishLink(reduceDeskLink(link, { type: 'label', label })),
      stopCurrent: () => {
        leaving = true;
        tunnel.stop();
      },
      forgetDesk: (pairId) => clearDeskMeta(localStorage, pairId),
    }),
    link: () => toRemoteLinkStatus(link, pushAvailability()),
    onLink(listener) {
      linkListeners.add(listener);
      return () => linkListeners.delete(listener);
    },
    togglePush: () =>
      void toggleDeskPush({
        enabled: () => link.pushEnabled,
        vapidPublicKey: () => link.vapidPublicKey,
        setPending: (pending) => publishLink(reduceDeskLink(link, { type: 'push', ...pending })),
        turnOn: (key) => turnPushOn(key, push),
        turnOff: () => bridge.setPushSubscription?.(null),
      }),
    theme: () => themeOfFrame(iframes.main),
    watchTheme: (listener) => watchFrameTheme(iframes.main, listener),
    diagnostics: () =>
      formatDiagnostics({
        now: Date.now(),
        bornAt: tunnel.bornAt,
        build: version,
        userAgent: navigator.userAgent,
        visibility: document.visibilityState,
        link: {
          ...toRemoteLinkStatus(link, pushAvailability()),
          ...tunnel.diagnostics(),
        },
        trace: tunnel.trace,
      }),
    wide: () => matchMedia(DESKTOP_DRAWER_QUERY).matches,
    pip: deskPip
      ? {
          state: () => ({ ...pipStatus, follow: pipFollow }),
          onChange(listener: () => void) {
            pipListeners.add(listener);
            return () => pipListeners.delete(listener);
          },
          toggle() {
            if (pipStatus.active) {
              stopNativePip();
              return;
            }
            // 先把最新对话推过去，浮窗一出来就有内容
            pipSync.flush();
            startNativePip();
          },
          setAuto(enabled: boolean) {
            saveNativePipAuto(localStorage, enabled);
            setNativePipAuto(enabled);
            publishPip({ ...pipStatus, auto: enabled });
          },
          setAspect(aspect: NativePipAspect) {
            saveNativePipAspect(localStorage, aspect);
            setNativePipAspect(aspect);
            publishPip({ ...pipStatus, aspect });
          },
          setFollow(mode: NativePipFollowMode) {
            pipFollow = mode;
            saveNativePipFollow(localStorage, mode);
            if (deskPip.setFollowMode(mode)) pipSync.flush();
            publishPip({ ...pipStatus });
          },
        }
      : undefined,
  });

  const bridge: RemoteBridge = {
    platform: 'linux',
    attach(kind) {
      attached[kind]?.close();
      const frame = tunnel.attach(kind, () => {
        const iframe = iframes[kind];
        void (async () => {
          await keepSnapshot();
          settingsLoaded = false;
          optimisticHydrated = false;
          await coverWithSnapshot();
          if (iframes.main === iframe) iframe?.contentWindow?.location.reload();
        })();
      });
      attached[kind] = frame;
      if (kind === 'main') {
        frame.on(IPC_CHANNELS.AGENT_EVENT, (payload) => {
          if (deskWidget.applyAgentEventPayload(payload)) syncNativeDeskWidget();
          if (deskPip?.applyAgentEventPayload(payload)) schedulePipSync();
        });
        frame.on(IPC_CHANNELS.CONVERSATIONS_PATCH, (payload) => {
          if (deskWidget.applyConversationsPatchPayload(payload)) syncNativeDeskWidget();
          if (deskPip?.applyConversationsPatchPayload(payload)) schedulePipSync();
        });
      }
      return {
        invoke: (channel, payload) => {
          const result = frame.invoke(channel, payload);
          if (deskPip && kind === 'main') {
            if (
              channel === IPC_CHANNELS.AGENT_PROMPT ||
              channel === IPC_CHANNELS.SOURCE_CONVERSATION_SELECT
            ) {
              const sessionId = parseInvokeSessionId(payload);
              if (sessionId && deskPip.setFocusedSession(sessionId)) schedulePipSync();
            } else if (channel === IPC_CHANNELS.AGENT_PARENT_HISTORY_TAIL) {
              const conversationId = parseInvokeSessionId(payload);
              if (conversationId) {
                deskPip.setFocusedSession(conversationId);
                schedulePipSync();
                void result.then(
                  (json) => {
                    if (deskPip.ingestHistoryTail(conversationId, json)) schedulePipSync();
                  },
                  () => {}
                );
              }
            }
          }
          if (channel === IPC_CHANNELS.SETTINGS_READ)
            void result.then(() => {
              if (!settingsLoaded) void markReady(version);
              settingsLoaded = true;
              syncNativeDeskWidget(true);
            });
          if (
            channel === IPC_CHANNELS.CONVERSATIONS_READ ||
            channel === IPC_CHANNELS.SOURCE_AUTHORITY_READ
          )
            void result.then(() => syncNativeDeskWidget(true));
          return result;
        },
        send: frame.send,
        on: frame.on,
        close: () => {
          frame.close();
          if (attached[kind] === frame) delete attached[kind];
        },
      };
    },
    leader: () => tunnel.leader,
    prefetch: {
      take: (key, expectedHash) => {
        const pending = tunnel.takePrefetch(key, expectedHash);
        if (pending && key === `${IPC_CHANNELS.SETTINGS_READ}\0[]`) {
          void pending.then((hit) => {
            if (hit !== null && hit !== undefined && !settingsLoaded) {
              settingsLoaded = true;
              void markReady(version);
            }
          });
        }
        return pending;
      },
    },
    optimistic: {
      enabled: true,
      onHydrated: (channel) => {
        if (channel === IPC_CHANNELS.SETTINGS_READ) optimisticHydrated = true;
        syncNativeDeskWidget(true);
      },
      onVerified: (channel) => {
        if (channel === IPC_CHANNELS.SETTINGS_READ && !settingsLoaded) {
          settingsLoaded = true;
          void markReady(version);
        }
        syncNativeDeskWidget(true);
      },
    },
    exitDesk() {
      leaveGuard?.release();
      location.href = PHONE_URL;
    },
    openDevices: () => drawer.open(),
    linkStatus: () => toRemoteLinkStatus(link, pushAvailability()),
    onLinkStatus(callback) {
      linkListeners.add(callback);
      return () => linkListeners.delete(callback);
    },
    vapidPublicKey: () => link.vapidPublicKey,
    setPushSubscription(subscription) {
      if (subscription === null) {
        turnPushOff(push);
        publishLink(
          reduceDeskLink(link, { type: 'push', enabled: false, busy: false, error: null })
        );
        return;
      }
      const parsed = parseRemotePushSubscription(subscription);
      if (!parsed) return;
      acceptPushSubscription(parsed, push);
      publishLink(reduceDeskLink(link, { type: 'push', enabled: true, busy: false, error: null }));
    },
    setPushPending(pending) {
      const parsed = parsePushPending(pending);
      if (!parsed) return;
      publishLink(reduceDeskLink(link, { type: 'push', ...parsed }));
    },
    setViewedSession(sessionId) {
      if (deskPip?.setFocusedSession(sessionId)) schedulePipSync();
    },
  };
  (window as Window & { __ensoRemote?: RemoteBridge }).__ensoRemote = bridge;
  // 后退先关抽屉，其余情况确认后才离开
  leaveGuard = installLeaveGuard(window, '确定离开 EnsoCode 完整版？', () => {
    if (drawer.isOpen()) {
      drawer.close();
      return true;
    }
    return false;
  });

  /**
   * 会话目录要等连上桌面才有，iframe 还没 attach 或目录未到时发一次会丢。
   * 重复选择会重走 authority，所以帧就绪后只发三次。
   */
  let focusGen = 0;
  const focusSession = (sessionId: string) => {
    if (deskPip?.setFocusedSession(sessionId)) schedulePipSync();
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

  /** 按版本寻址的图取到过就留本地副本：冷启动不等桌面，桌面那边换了图地址会变 */
  const cacheStorage = typeof caches === 'undefined' ? null : caches;
  const deskImageUrl = (path: string) =>
    `${location.origin}/desk/li/${encodeURIComponent(device.pairId)}/${path.slice(3)}`;
  const fetchDeskImage = async (path: string): Promise<DeskAsset> => {
    const url = deskImageUrl(path);
    const hit = cacheStorage
      ? await withTimeout(
          cachedRemoteImage(cacheStorage, url).catch(() => undefined),
          STORAGE_TIMEOUT_MS,
          undefined
        )
      : undefined;
    if (hit) {
      const mime = hit.headers.get('content-type') ?? 'application/octet-stream';
      return { status: 200, mime, body: new Uint8Array(await hit.arrayBuffer()) };
    }
    const asset = await fetchDeskAsset(path);
    if (cacheStorage) void storeRemoteImage(cacheStorage, url, asset).catch(() => {});
    return asset;
  };

  const fetchDeskResource = (path: string): Promise<DeskAsset> =>
    path.startsWith('li/') ? fetchDeskImage(path) : fetchDeskAsset(path);

  if (nativeDeskProxy) {
    registerNativeDeskFetcher(fetchDeskResource);
  }
  window.addEventListener('enso:open-session', (event) => {
    const detail = (event as CustomEvent<{ sessionId?: unknown }>).detail;
    const sessionId = parseSessionId(detail?.sessionId);
    if (sessionId) focusSession(sessionId);
  });
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.addEventListener('message', (event) => {
      const data = event.data as { type?: unknown; path?: unknown; sessionId?: unknown } | null;
      if (data?.type === 'open-session') {
        const sessionId = parseSessionId(data.sessionId);
        if (sessionId) focusSession(sessionId);
        return;
      }
      const port = event.ports[0];
      if (data?.type !== 'desk-fetch' || typeof data.path !== 'string' || !port) return;
      void fetchDeskResource(data.path).then((asset) => {
        const body = asset.body.slice().buffer;
        port.postMessage({ status: asset.status, mime: asset.mime, body }, [body]);
      });
    });
  }

  /** 某个构建曾完整起来过（资源都在 SW 缓存里）：可以不等宿主，直接起 renderer */
  const cachedBuild = async (meta: DeskMeta): Promise<boolean> => {
    if (!cacheStorage) return false;
    try {
      const ready = cacheStorage
        .open(`${DESK_CACHE_PREFIX}${meta.version}`)
        .then((cache) => buildReady(cache, location.origin, deskBase(device.pairId, meta.version)));
      return await withTimeout(ready, STORAGE_TIMEOUT_MS, false);
    } catch {
      return false;
    }
  };

  const markReady = async (build: string): Promise<void> => {
    if (!build || !cacheStorage) return;
    try {
      const cache = await cacheStorage.open(`${DESK_CACHE_PREFIX}${build}`);
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
    const blobs = snapshotBlobs;
    snapshotBlobs = [];
    syncing = false;
    renderStatus();
    const release = () => {
      el?.remove();
      for (const url of blobs) URL.revokeObjectURL(url);
    };
    if (!el) {
      release();
      return;
    }
    tunnel.note('snapshot-reveal');
    el.style.opacity = '0';
    setTimeout(release, 200);
  };

  /** 快照里的远程图换成本地副本；没有副本的去掉，不显示裂图（快照不跑脚本，也可能不经 SW） */
  const localSnapshotImage = async (src: string): Promise<string | null> => {
    if (!cacheStorage) return null;
    const hit = await snapshotImage(cacheStorage, new URL(src, location.origin).href);
    if (!hit) return null;
    const url = URL.createObjectURL(await hit.blob());
    snapshotBlobs.push(url);
    return url;
  };

  /** 先盖上次的界面，renderer 拿到设置且内容基本追上（或稳定下来）再揭开 */
  const coverWithSnapshot = async (): Promise<void> => {
    const saved = await withTimeout(
      loadSnapshot(`${DESK_CACHE_PREFIX}${version}`, base),
      STORAGE_TIMEOUT_MS,
      null
    );
    if (!saved || !iframes.main) return;
    if (snapshotTimer) {
      clearInterval(snapshotTimer);
      snapshotTimer = null;
    }
    const html = snapshot
      ? ''
      : await rehydrateImages(saved.html, (src) =>
          withTimeout(
            localSnapshotImage(src).catch(() => null),
            STORAGE_TIMEOUT_MS,
            null
          )
        );
    if (!iframes.main) return;
    if (!snapshot) {
      const mounted = mountSnapshot(frames, html);
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
    coverSavedAt = saved.savedAt;
    tunnel.note('snapshot-cover');
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
        optimisticHydrated,
        liveLoading: Boolean(
          iframes.main?.contentDocument?.querySelector('[data-timeline-loading]')
        ),
        hostOnline: lastState === 'online',
        requestsIdle: tunnel.idle('main'),
      });
      if (!ready) return;
      dropSnapshot();
    }, 100);
  };

  (window as Window & { __deskTrace?: unknown }).__deskTrace = tunnel.trace;

  /** 切后台/离开时存一份当前界面和只读缓存，下次启动先显示它 */
  const keepSnapshot = async (): Promise<void> => {
    if (!version || leaving) return;
    const sig = readsSignature(reads);
    if (sig !== savedReadsSig) {
      savedReadsSig = sig;
      void saveReads(`${DESK_CACHE_PREFIX}${version}`, base, reads).catch(() => {
        savedReadsSig = '';
      });
    }
    const doc = iframes.main?.contentDocument;
    if (snapshot || !settingsLoaded || !doc) return;
    await saveSnapshot(`${DESK_CACHE_PREFIX}${version}`, base, doc).catch(() => {});
  };
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') void keepSnapshot();
    else clearBadge();
  });
  window.addEventListener('pagehide', () => void keepSnapshot());
  window.addEventListener('enso:background', () => void keepSnapshot());
  window.addEventListener('enso:foreground', () => clearBadge());
  clearBadge();
  setInterval(() => {
    if (document.visibilityState === 'visible') void keepSnapshot();
  }, 60_000);

  /** 回到前台即清角标：待处理项在界面里看得到 */
  function clearBadge(): void {
    navigator.serviceWorker?.controller?.postMessage({ type: 'badge-clear' });
  }

  /** 首次（或桌面升级后）要经隧道下载整套界面：盖着启动画面并报进度，iframe 加载完再露出 */
  const mountFresh = (total: number | undefined, cacheLost: boolean): void => {
    const iframe = mount('main');
    const started = tunnel.downloadedBytes;
    const reason = cacheLost
      ? '本地缓存不在了（可能被系统清理），正在重新下载界面…'
      : '正在下载完整版界面（首次或桌面端升级后需要）…';
    const timer = setInterval(() => {
      // 中继给的是原始字节，与按隧道帧估的总量不同口径：走了中继就只显示已下载
      const fromRelay = relay?.bytes ?? 0;
      const done = tunnel.downloadedBytes - started + fromRelay;
      progress(`${reason} ${downloadProgress(done, fromRelay ? undefined : total)}`);
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

  clearTimeout(bootWatchdog);
  const cached = loadDeskMeta(localStorage, device.pairId);
  if (cached) {
    const saved = await withTimeout(
      loadReads(`${DESK_CACHE_PREFIX}${cached.version}`, deskBase(device.pairId, cached.version)),
      STORAGE_TIMEOUT_MS,
      new Map<string, { h: string; json: string }>()
    );
    for (const [key, entry] of saved) reads.set(key, entry);
    savedReadsSig = readsSignature(reads);
    syncNativeDeskWidget(true);
  }
  tunnel.start();
  const launched = cached !== null && (await cachedBuild(cached));
  if (launched) {
    use(cached);
    mount('main');
    await coverWithSnapshot();
    revealFrames();
  }
  watchDeskChrome(() => iframes.main);

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
  clearBootRetry(sessionStorage);
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
  if (cacheStorage) {
    void pruneRemoteImages(
      cacheStorage,
      devices.map((d) => d.pairId)
    ).catch(() => {});
  }

  // 上一次启动的构建保留到下次：升级时 SW 从中复用内容未变的带指纹文件
  const keep = new Set([current.version, cached?.version].map((v) => `${DESK_CACHE_PREFIX}${v}`));
  if (cacheStorage) {
    void cacheStorage
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((k) => k.startsWith(DESK_CACHE_PREFIX) && !keep.has(k))
            .map((k) => cacheStorage.delete(k))
        )
      )
      .catch(() => {});
  }

  if (launched && cached.version === current.version) return;
  // 桌面已升级（或首次）：换到新构建，旧构建的快照也不再适用
  use(current);
  dropSnapshot();
  settingsLoaded = false;
  optimisticHydrated = false;
  attached.main?.close();
  delete attached.main;
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
  mountFresh(download, cached?.version === current.version);
}

void main().catch((error) => splash(`启动失败：${error instanceof Error ? error.message : error}`));
