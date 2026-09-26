import os from 'node:os';
import {
  attachHeartbeat,
  backoffDelay,
  buildPairLink,
  type CatalogEntry,
  DEFAULT_RELAY_URL,
  DirectLink,
  type DirectSignal,
  fromBase64Url,
  type Heartbeat,
  type HostAppearance,
  type HostPairSession,
  type HostToPhone,
  openFrame,
  type PairedDevice,
  type PairSyncCursor,
  type ProjectEntry,
  type ProjectGroupEntry,
  type ProviderEntry,
  pollHostPairing,
  revokePairing,
  sealFrame,
  shouldReplaceOnNudge,
  startHostPairing,
  type TerminalPalette,
  toBase64Url,
  toWebSocketUrl,
} from '@enso/pair';
import {
  catalogSyncFingerprint,
  channelsForMetaPush,
  forgetGuestSyncMeta,
  mergeStableMeta,
  type PairMetaFingerprints,
  pairJsonFingerprint,
  planProviderEmit,
  providerChannelsToSend,
  providersSyncFingerprint,
  rememberStableMeta,
  shouldRelayPairSnapshot,
  slimCatalogForPhone,
  slimProjectsForPhone,
} from '@shared/pair/metaSync';
import { normalizeTimelinePrefs, type PairTimelinePrefs } from '@shared/pair/timelinePrefs';
import type {
  AgentSpawnRequest,
  ApprovalDecision,
  AttachedImage,
  RendererAgentEvent,
} from '@shared/types/agent';
import type {
  PairCreatedSession,
  PairQueueAction,
  PairSessionConfig,
  PairStatus,
} from '@shared/types/pair';
import { app, powerMonitor, powerSaveBlocker } from 'electron';
import { readTrayPreventDisplaySleep, readTraySleepPolicy } from '../ipc/settings';
// 会话命令一律走 agentBridge（身份解析留在 ipc/agent.ts），这里只留无需身份的 snapshot。
import { requestSnapshot, setPinnedSessions } from './agentHost';
import { MacosSystemSleepAssertion } from './macosSystemSleepAssertion';
import { readNotifyMainAgentOnly } from './notifications';
import { PAIR_DIRECT_ENABLED, PAIR_STUN_SERVERS } from './pairDirectConfig';
import { isDirectPeerAvailable, mainDirectPeerFactory, preloadDirectPeer } from './pairDirectPeer';
import { flushChangedMeta, requestPairMeta } from './pairMetaFlush';
import { startPairNetworkWatch } from './pairNetworkWatch';
import {
  checkSetModel,
  checkSpawn,
  narrowSnapshot,
  parsePhoneCommand,
  type SpawnWhitelist,
  shouldForward,
  sliceHistory,
} from './pairPolicy';
import {
  applyPairPowerTaskEvent,
  powerSaveBlockerKind,
  shouldHoldPairPowerKeepAlive,
} from './pairPowerKeepAlive';
import { seedRelayHostCache } from './pairRelayLookup';
import { openPairRelayWebSocket } from './pairRelayOpen';
import { PairReplayLog } from './pairReplay';
import {
  isSecureStorageAvailable,
  loadDevices,
  loadRelayHostCache,
  loadRelayUrl,
  renameDevice as renameInList,
  saveDevices,
  saveRelayUrl,
  upsertDevice,
} from './pairStore';
import {
  buildPushPayload,
  clearPushSubscription,
  getVapidPublicKey,
  hasPushSubscription,
  sendPush,
  setPushSubscription,
} from './pushNotifier';

/**
 * 手机第二屏 host：跑在 main，不依赖窗口焦点。
 * 连中继（每台已配对设备一条 WSS）、解密白名单命令打进 agentHost、
 * 加密下发 agent 事件与目录。中继只见密文。
 */

export interface PairStatusDevice {
  pairId: string;
  deviceName: string;
  pairedAt: number;
  connected: boolean;
  phoneOnline: boolean;
  transport?: 'relay' | 'direct';
  rttMs?: number;
}

interface Connection {
  device: PairedDevice;
  contentKey: Uint8Array;
  ws: WebSocket | null;
  heartbeat: Heartbeat | null;
  /** WebRTC 直连：业务帧优先出口；信令与在线态仍走中继 */
  direct: DirectLink;
  /** 手机当前订阅的会话（null = 列表页，不收正文） */
  subscribedId: string | null;
  sinceIndex?: number;
  /** 待应答的 history 分页请求（beforeIndex）；下一个 snapshot 事件到达时切片发回 */
  pendingHistory?: number;
  /** 手机 subscribe 已点名会话快照；桌面自发 snapshot 不转 */
  pendingSnapshot?: boolean;
  pendingSync?: {
    sessionId: string;
    requestId: string;
    revision: number;
    answered?: boolean;
  };
  syncRevision: number;
  syncLiveRevision?: number;
  /** 该连接用过 session-sync；之后 live 事件带 cursor，不受 pendingSync 应答影响 */
  syncCapable?: boolean;
  /** 已下发 meta 各通道指纹；相同内容不重发 */
  sentMeta?: PairMetaFingerprints;
  metaDirty: boolean;
  metaSending: boolean;
  metaEpoch?: number;
  providersSentFp?: string;
  providersSentAt?: number;
  /** 窗口内没发出的模型表：到点补推，不能把新指纹提前记成已同步 */
  providersRetry?: NodeJS.Timeout | null;
  phoneOnline: boolean;
  /** 当前业务通道 RTT（ms）；切通道时清空 */
  rttMs: number | null;
  /** 手机页面可见性（presence 帧上报）：锁屏/切后台时 socket 半开不会 close，推送据此门控 */
  phoneVisible: boolean;
  attempt: number;
  timer: NodeJS.Timeout | null;
  closed: boolean;
  generation: number;
  ioEpoch: number;
  receiveQueue: Promise<void>;
  sendQueue: Promise<void>;
}

const connections = new Map<string, Connection>();
const stableMetaByPair = new Map<string, PairMetaFingerprints>();
const sentProviderFp = new Map<string, string>();
const replayLog = new PairReplayLog();
let pairingSession: HostPairSession | null = null;
let pairingTimer: NodeJS.Timeout | null = null;
let pairingInviteUri: string | null = null;
let pairingExpiresAt: number | null = null;
let onStatusChange: (() => void) | null = null;
/** 请渲染层恢复某会话（手机订阅历史会话时用） */
let onResumeRequest: ((sessionId: string) => void) | null = null;
let onSessionCreated: ((session: PairCreatedSession) => void) | null = null;
/** 手机改会话模型/推理档位：renderer 应用到会话 store（与桌面选择器同一路径） */
let onSessionConfig: ((config: PairSessionConfig) => void) | null = null;
/** 手机操作排队消息：队列只存于 renderer store，不能走 agentBridge（会绕过 store 失配） */
let onQueueAction: ((action: PairQueueAction) => void) | null = null;

/** renderer 推上来的目录快照（会话标题/项目/provider 只在 renderer 有） */
let catalog: CatalogEntry[] = [];
/**
 * renderer 是否已推过至少一次目录。为 false 时上面的空初值不是真目录，不得下发：
 * host 重启时对端已在房里，peer-joined 先于 renderer 首次 push，空目录会让对端误判幽灵会话。
 */
let catalogReady = false;
let pinnedOrder: string[] = [];
let projects: ProjectEntry[] = [];
let projectGroups: ProjectGroupEntry[] = [];
let providers: ProviderEntry[] = [];
/** false：还没有一份可下发的模型表（OAuth 暂态空列表不能当真） */
let providersSettled = false;
/** 桌面外观偏好，随目录下发给手机作为默认值 */
let theme: HostAppearance = 'system';
/** 桌面终端配色（bash 输出用），随外观一起下发 */
let terminal: TerminalPalette | undefined;
let terminalFontFamily: string | undefined;
let compactReadOnlyTools = true;
let expandLiveEdits = true;
let timelinePrefs: PairTimelinePrefs = normalizeTimelinePrefs({});
/** 剥密前的完整项目路径映射，用于 spawn 反查 cwd */
let whitelist: SpawnWhitelist = { projects: [], providers: [] };

export function setPairStatusListener(listener: () => void): void {
  onStatusChange = listener;
}

export function setPairResumeListener(listener: (sessionId: string) => void): void {
  onResumeRequest = listener;
}

/**
 * 手机侧只持有裸 sessionId，而 agentHost 的会话命令已收紧为 exact identity（带 generation）。
 * 身份解析与 spawn 准入属于策略，留在 ipc/agent.ts；pairHost 只做传输，通过此桥调用。
 * 未注入或解析不出身份时一律 fail-closed，不降级成按 sessionId 盲发。
 */
export interface PairAgentBridge {
  prompt(sessionId: string, text: string, images?: AttachedImage[]): void;
  steer(sessionId: string, text: string, images?: AttachedImage[]): void;
  abort(sessionId: string): void;
  respondApproval(sessionId: string, requestId: string, decision: ApprovalDecision): void;
  respondAsk(sessionId: string, requestId: string, answer: string): void;
  spawn(request: AgentSpawnRequest): Promise<{ ok: boolean; error?: string }>;
}

let agentBridge: PairAgentBridge | null = null;

export function setPairAgentBridge(bridge: PairAgentBridge): void {
  agentBridge = bridge;
}

export function setPairSessionCreatedListener(
  listener: (session: PairCreatedSession) => void
): void {
  onSessionCreated = listener;
}

export function setPairSessionConfigListener(listener: (config: PairSessionConfig) => void): void {
  onSessionConfig = listener;
}

export function setPairQueueActionListener(listener: (action: PairQueueAction) => void): void {
  onQueueAction = listener;
}

let powerBlockerId: number | null = null;
let powerBlockerKind: ReturnType<typeof powerSaveBlockerKind> | null = null;
const macosSystemSleepAssertion = new MacosSystemSleepAssertion();
let runningTaskIds = new Set<string>();

/**
 * 按托盘休眠策略持锁。默认屏幕仍可熄；打开「不休眠时阻止息屏」后改挡息屏。
 * macOS 再加 caffeinate -i -s（阻止息屏时含 -d）。合盖仍可能被系统强制睡。
 */
function syncPowerBlocker(): void {
  const preventDisplaySleep = readTrayPreventDisplaySleep();
  const shouldBlock = shouldHoldPairPowerKeepAlive(readTraySleepPolicy(), runningTaskIds.size);
  if (shouldBlock) {
    const kind = powerSaveBlockerKind(preventDisplaySleep);
    if (powerBlockerId !== null && powerBlockerKind !== kind) {
      powerSaveBlocker.stop(powerBlockerId);
      powerBlockerId = null;
      powerBlockerKind = null;
    }
    if (powerBlockerId === null) {
      powerBlockerId = powerSaveBlocker.start(kind);
      powerBlockerKind = kind;
    }
    macosSystemSleepAssertion.start('pair-keep-alive', { preventDisplaySleep });
  } else {
    if (powerBlockerId !== null) {
      powerSaveBlocker.stop(powerBlockerId);
      powerBlockerId = null;
      powerBlockerKind = null;
    }
    macosSystemSleepAssertion.stop('pair-keep-alive');
  }
}

export function refreshPowerKeepAlive(): void {
  syncPowerBlocker();
}

function notifyStatus(): void {
  syncPowerBlocker();
  syncPinnedSessions();
  onStatusChange?.();
}

/** 手机在线且订阅中的会话不参与 worker 闲置回收（回收了手机就收不到投影了） */
function syncPinnedSessions(): void {
  const ids: string[] = [];
  for (const conn of connections.values()) {
    if (!conn.closed && conn.phoneOnline && conn.subscribedId) ids.push(conn.subscribedId);
  }
  setPinnedSessions('pair', ids);
}

// ── 生命周期 ──────────────────────────────────────────────────────────

let resumeHooked = false;
let stopNetworkWatch: (() => void) | null = null;
let cacheSeeded = false;

function ensureRelayCacheSeeded(): void {
  if (cacheSeeded) return;
  cacheSeeded = true;
  seedRelayHostCache(loadRelayHostCache());
}

export function startPairHost(): void {
  ensureRelayCacheSeeded();
  syncPowerBlocker();
  if (!resumeHooked) {
    resumeHooked = true;
    // 睡眠唤醒后 TCP 多半已死但 close 事件不会来：活链立即探测，死链立即重连
    powerMonitor.on('resume', () => reviveAll('resume'));
    stopNetworkWatch = startPairNetworkWatch({ onChange: () => reviveAll('network-change') });
  }
  // 先装好 WebRTC 原生模块再进房：host-info 的能力声明在首次 meta 推送就要确定
  void preloadDirectPeer().finally(() => {
    for (const device of loadDevices()) {
      openConnection(device);
    }
  });
}

function reviveAll(reason: 'resume' | 'network-change'): void {
  for (const conn of connections.values()) {
    if (conn.closed) continue;
    if (reason === 'network-change') conn.direct.networkChange();
    if (shouldReplaceOnNudge(reason, conn.ws !== null, conn.ws?.readyState ?? null)) {
      if (conn.timer) clearTimeout(conn.timer);
      conn.attempt = 0;
      if (conn.ws) {
        try {
          conn.ws.close();
        } catch {}
      } else {
        connect(conn);
      }
      continue;
    }
    conn.heartbeat?.probe();
  }
}

export function stopPairHost(): void {
  stopNetworkWatch?.();
  stopNetworkWatch = null;
  cancelPairing();
  for (const conn of connections.values()) {
    conn.closed = true;
    conn.ioEpoch++;
    conn.syncRevision++;
    if (conn.timer) clearTimeout(conn.timer);
    if (conn.providersRetry) clearTimeout(conn.providersRetry);
    conn.heartbeat?.stop();
    conn.heartbeat = null;
    conn.direct.close();
    try {
      conn.ws?.close();
    } catch {}
  }
  connections.clear();
  replayLog.invalidateAll();
  syncPowerBlocker();
}

// ── 配对 ──────────────────────────────────────────────────────────────

// undefined = 尚未从磁盘读过；null = 读过且没有自定义值，用默认
let relayUrlOverride: string | null | undefined;

export function getRelayUrl(): string {
  if (relayUrlOverride === undefined) relayUrlOverride = loadRelayUrl();
  return relayUrlOverride ?? DEFAULT_RELAY_URL;
}

export function setRelayUrl(url: string): void {
  relayUrlOverride = url.trim() ? url.trim() : null;
  saveRelayUrl(relayUrlOverride);
}

/** 配对码有效期，与中继侧 PAIR_TTL_MS 保持一致 */
const PAIRING_TTL_MS = 60_000;

/** 生成一次性密钥对 + 中继登记，返回 QR 内容；随后轮询等待手机认领 */
export async function startPairing(): Promise<{ ok: boolean; inviteUri?: string; error?: string }> {
  cancelPairing();
  try {
    const relay = getRelayUrl();
    pairingSession = await startHostPairing(relay);
    pairingInviteUri = buildPairLink({
      relay,
      publicKey: fromBase64Url(pairingSession.publicKeyB64),
    });
    pairingExpiresAt = Date.now() + PAIRING_TTL_MS;
    pollPairing();
    notifyStatus();
    return { ok: true, inviteUri: pairingInviteUri };
  } catch (error) {
    pairingSession = null;
    pairingInviteUri = null;
    pairingExpiresAt = null;
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export function cancelPairing(): void {
  if (pairingTimer) clearTimeout(pairingTimer);
  pairingTimer = null;
  pairingSession = null;
  pairingInviteUri = null;
  pairingExpiresAt = null;
  notifyStatus();
}

/** 轮询中继直到手机 claim；到期自动停（与 UI 倒计时同一时间戳） */
function pollPairing(): void {
  const tick = async (): Promise<void> => {
    const session = pairingSession;
    if (!session) return;
    if (pairingExpiresAt !== null && Date.now() > pairingExpiresAt) {
      cancelPairing();
      return;
    }
    try {
      const result = await pollHostPairing(session);
      if (result) {
        const device: PairedDevice = {
          pairId: result.pairId,
          token: result.hostToken,
          contentKey: toBase64Url(result.contentKey),
          deviceName: result.deviceName,
          relayUrl: session.relayUrl,
          pairedAt: Date.now(),
        };
        saveDevices(upsertDevice(loadDevices(), device));
        pairingSession = null;
        pairingInviteUri = null;
        pairingExpiresAt = null;
        openConnection(device);
        notifyStatus();
        return;
      }
    } catch {
      // 网络抖动：继续轮询直到 TTL
    }
    pairingTimer = setTimeout(() => void tick(), 800);
  };
  void tick();
}

export function renameDevice(pairId: string, deviceName: string): { ok: boolean; error?: string } {
  const list = loadDevices();
  if (!list.some((d) => d.pairId === pairId)) return { ok: false, error: 'device not found' };
  const next = renameInList(list, pairId, deviceName);
  saveDevices(next);
  const conn = connections.get(pairId);
  const renamed = next.find((d) => d.pairId === pairId);
  if (conn && renamed) conn.device = renamed;
  notifyStatus();
  return { ok: true };
}

export async function revokeDevice(pairId: string): Promise<void> {
  const device = loadDevices().find((d) => d.pairId === pairId);
  forgetDevice(pairId);
  if (device) {
    try {
      await revokePairing(device.relayUrl, pairId, device.token);
    } catch {}
  }
  notifyStatus();
}

export function getPairStatus(): PairStatus {
  return {
    relayUrl: getRelayUrl(),
    pairing: pairingSession !== null,
    ...(pairingInviteUri ? { inviteUri: pairingInviteUri } : {}),
    ...(pairingExpiresAt ? { pairingExpiresAt } : {}),
    secureStorage: isSecureStorageAvailable(),
    devices: loadDevices().map((d) => {
      const conn = connections.get(d.pairId);
      return {
        pairId: d.pairId,
        deviceName: d.deviceName,
        pairedAt: d.pairedAt,
        connected: conn?.ws?.readyState === 1,
        phoneOnline: conn?.phoneOnline ?? false,
        transport: conn?.direct.transport() ?? 'relay',
        ...(conn?.phoneOnline && conn.rttMs != null ? { rttMs: conn.rttMs } : {}),
      };
    }),
  };
}

// ── 连接与重连 ────────────────────────────────────────────────────────

function openConnection(device: PairedDevice): void {
  const existing = connections.get(device.pairId);
  if (existing) {
    existing.closed = true;
    existing.ioEpoch++;
    existing.syncRevision++;
    if (existing.timer) clearTimeout(existing.timer);
    if (existing.providersRetry) clearTimeout(existing.providersRetry);
    existing.heartbeat?.stop();
    existing.heartbeat = null;
    existing.direct.close();
    try {
      existing.ws?.close();
    } catch {}
  }
  const conn: Connection = {
    device,
    contentKey: fromBase64Url(device.contentKey),
    ws: null,
    heartbeat: null,
    direct: null as unknown as DirectLink,
    subscribedId: null,
    metaDirty: false,
    metaSending: false,
    phoneOnline: false,
    rttMs: null,
    phoneVisible: true,
    attempt: 0,
    timer: null,
    closed: false,
    generation: 0,
    ioEpoch: 0,
    syncRevision: 0,
    receiveQueue: Promise.resolve(),
    sendQueue: Promise.resolve(),
  };
  conn.direct = new DirectLink({
    role: 'host',
    factory: PAIR_DIRECT_ENABLED && isDirectPeerAvailable() ? mainDirectPeerFactory : null,
    iceServers: PAIR_STUN_SERVERS,
    // 信令只走中继：绕过 send() 的出口选择
    sendSignal: (signal) => void sendViaRelay(conn, signal),
    onFrame: (frame) => enqueueFrame(conn, frame, conn.generation, conn.ioEpoch),
    onTransportChange: (transport) => {
      conn.rttMs = null;
      // 直连掉了且中继也不在：两条路都没了才算离线，转系统推送
      if (transport === 'relay' && conn.ws?.readyState !== 1) conn.phoneOnline = false;
      notifyStatus();
    },
    onRtt: (ms) => {
      conn.rttMs = ms;
      notifyStatus();
    },
    // 切通道的瞬间旧通道在途帧可能丢：目录类重推，会话正文由手机自己 subscribe 补
    onResync: () => {
      // 直连打开不是新进房：catalog 指纹还在就别再打一遍 14kB 瘦目录
      resyncGuestMeta(conn, false);
    },
    onDiagnostic: (line) => console.log(`[pair] ${device.deviceName}: ${line}`),
  });
  connections.set(device.pairId, conn);
  connect(conn);
}

function connect(conn: Connection): void {
  if (conn.closed) return;
  const generation = ++conn.generation;
  const base = toWebSocketUrl(conn.device.relayUrl);
  const url = `${base}/v1/pair/${encodeURIComponent(conn.device.pairId)}?role=host&token=${encodeURIComponent(conn.device.token)}`;
  void openPairRelayWebSocket(url)
    .then((ws) => attachHostSocket(conn, ws, generation))
    .catch(() => {
      if (!conn.closed && conn.generation === generation) scheduleReconnect(conn);
    });
}

function clearConnectionSubscription(conn: Connection): void {
  conn.ioEpoch++;
  conn.syncRevision++;
  conn.receiveQueue = Promise.resolve();
  conn.sendQueue = Promise.resolve();
  conn.subscribedId = null;
  conn.sinceIndex = undefined;
  conn.pendingSnapshot = undefined;
  conn.pendingHistory = undefined;
  conn.pendingSync = undefined;
  conn.syncLiveRevision = undefined;
}

function attachHostSocket(conn: Connection, ws: WebSocket, generation: number): void {
  if (conn.closed || conn.generation !== generation) {
    try {
      ws.close();
    } catch {}
    return;
  }
  ws.binaryType = 'arraybuffer';
  conn.ws = ws;

  // 半开死链的 close 事件可能永不到达：心跳判死后直接走关闭路径，幂等防双跑
  let settled = false;
  const closed = (code: number | null): void => {
    if (settled) return;
    settled = true;
    if (conn.closed || conn.generation !== generation || conn.ws !== ws) return;
    conn.heartbeat?.stop();
    conn.heartbeat = null;
    conn.ws = null;
    // 直连还活着就不算手机离线：业务帧继续走 DataChannel（直连再掉时由 onTransportChange 补置离线）
    if (conn.direct.transport() !== 'direct') {
      conn.phoneOnline = false;
      clearConnectionSubscription(conn);
    }
    // 1008 = 中继明确告知凭据已失效（解绑时下发，或带失效凭据重连时下发）。
    // 不能只看「连不上」就放弃，那是正常的网络波动，仍需重连。
    if (code === 1008) {
      dropRevoked(conn);
      return;
    }
    notifyStatus();
    scheduleReconnect(conn);
  };
  conn.heartbeat = attachHeartbeat(
    ws,
    () => {
      try {
        ws.close();
      } catch {}
      closed(null);
    },
    (ms) => {
      if (conn.direct.transport() === 'relay') {
        conn.rttMs = ms;
        notifyStatus();
      }
    }
  );

  ws.onopen = () => {
    conn.attempt = 0;
    notifyStatus();
  };

  ws.onmessage = (event) => {
    if (conn.closed || conn.generation !== generation || conn.ws !== ws) return;
    if (typeof event.data === 'string') {
      // 中继明文控制帧
      try {
        const control = JSON.parse(event.data) as { type?: string };
        if (control.type === 'peer-joined') {
          conn.phoneOnline = true;
          conn.phoneVisible = true;
          conn.direct.peerOnline(true);
          // 中继重连期间直连一直在用：订阅没断过，不清
          if (conn.direct.transport() !== 'direct') {
            clearConnectionSubscription(conn);
          }
          // 进房重推 catalog；providers 等低频通道按指纹跳过
          resyncGuestMeta(conn);
          notifyStatus();
        } else if (control.type === 'peer-left') {
          conn.phoneOnline = false;
          conn.direct.peerOnline(false);
          if (conn.direct.transport() !== 'direct') clearConnectionSubscription(conn);
          notifyStatus();
        } else if (control.type === 'revoked') {
          // 手机端解除了配对：连凭据一起清掉，否则设置页会一直挂着一个连不上的设备
          dropRevoked(conn);
        }
      } catch {}
      return;
    }
    enqueueFrame(conn, new Uint8Array(event.data as ArrayBuffer), generation, conn.ioEpoch);
  };

  ws.onclose = (event) => closed(event.code);

  ws.onerror = () => {
    try {
      ws.close();
    } catch {}
  };
}

/** 断开并忘记某台设备（本端解绑与对端解绑共用） */
function forgetDevice(pairId: string): void {
  stableMetaByPair.delete(pairId);
  sentProviderFp.delete(pairId);
  const conn = connections.get(pairId);
  if (conn) {
    conn.closed = true;
    conn.ioEpoch++;
    conn.syncRevision++;
    if (conn.timer) clearTimeout(conn.timer);
    if (conn.providersRetry) clearTimeout(conn.providersRetry);
    conn.heartbeat?.stop();
    conn.heartbeat = null;
    conn.direct.close();
    try {
      conn.ws?.close();
    } catch {}
    conn.ws = null;
    connections.delete(pairId);
  }
  // 设备忘掉，推送订阅也一并清：避免继续向已解绑的手机发通知
  clearPushSubscription(pairId);
  saveDevices(loadDevices().filter((d) => d.pairId !== pairId));
}

/** 配对已被对端解除：清干净并通知渲染层，不再重连 */
function dropRevoked(conn: Connection): void {
  forgetDevice(conn.device.pairId);
  notifyStatus();
}

function scheduleReconnect(conn: Connection): void {
  if (conn.closed) return;
  if (conn.timer) clearTimeout(conn.timer);
  const delay = backoffDelay(conn.attempt++);
  conn.timer = setTimeout(() => connect(conn), delay);
}

// ── 收：解密 + 白名单 + 打进 agentHost ─────────────────────────────────

function connectionCurrent(conn: Connection, generation: number, ioEpoch: number): boolean {
  return !conn.closed && conn.generation === generation && conn.ioEpoch === ioEpoch;
}

function enqueueFrame(
  conn: Connection,
  frame: Uint8Array,
  generation: number,
  ioEpoch: number
): void {
  const task = conn.receiveQueue.then(async () => {
    if (!connectionCurrent(conn, generation, ioEpoch)) return;
    await handleFrame(conn, frame, generation, ioEpoch);
  });
  conn.receiveQueue = task.catch((error) => {
    console.warn('[pair] receive failed', error);
  });
}

function isCurrentSync(conn: Connection, revision: number, sessionId: string): boolean {
  return (
    conn.syncRevision === revision &&
    conn.subscribedId === sessionId &&
    conn.pendingSync?.revision === revision
  );
}

async function handleFrame(
  conn: Connection,
  frame: Uint8Array,
  generation: number,
  ioEpoch: number
): Promise<void> {
  let payload: unknown;
  try {
    payload = await openFrame(conn.contentKey, frame);
  } catch {
    console.warn('[pair] frame decrypt failed, dropped');
    return;
  }
  if (!connectionCurrent(conn, generation, ioEpoch)) return;
  // 解密成功才证明当前连接的手机仍在房间里，旧队列不能复活已关闭连接。
  if (!conn.phoneOnline) {
    conn.phoneOnline = true;
    notifyStatus();
  }
  const parsed = parsePhoneCommand(payload);
  if (!parsed.ok) {
    console.warn(`[pair] command rejected: ${parsed.error}`);
    return;
  }
  const command = parsed.command;
  switch (command.type) {
    case 'prompt':
      agentBridge?.prompt(command.sessionId, command.text, command.images);
      break;
    case 'steer':
      agentBridge?.steer(command.sessionId, command.text, command.images);
      break;
    case 'abort':
      agentBridge?.abort(command.sessionId);
      break;
    case 'approval-respond':
      agentBridge?.respondApproval(command.sessionId, command.requestId, command.decision);
      break;
    case 'ask-respond':
      agentBridge?.respondAsk(command.sessionId, command.requestId, command.answer);
      break;
    case 'subscribe': {
      const waiting =
        Boolean(command.sessionId) &&
        Boolean(command.sync) &&
        conn.pendingSync !== undefined &&
        !conn.pendingSync.answered &&
        conn.pendingSync.sessionId === command.sessionId;
      const revision = ++conn.syncRevision;
      conn.subscribedId = command.sessionId;
      conn.sinceIndex = command.sync ? undefined : command.sinceIndex;
      // 换了订阅，旧会话的分页请求作废
      conn.pendingHistory = undefined;
      conn.pendingSnapshot = undefined;
      conn.syncLiveRevision = undefined;
      if (command.sessionId && command.sync) {
        const sessionId = command.sessionId;
        const replay = command.sync.cursor
          ? replayLog.replay(sessionId, command.sync.cursor)
          : null;
        conn.syncCapable = true;
        conn.pendingSync = {
          sessionId,
          requestId: command.sync.requestId,
          revision,
        };
        if (replay) {
          void send(
            conn,
            {
              type: 'session-sync',
              sessionId,
              requestId: command.sync.requestId,
              cursor: replay.cursor,
              mode: 'replay',
              fromSeq: replay.fromSeq,
              events: replay.events,
            },
            () => isCurrentSync(conn, revision, sessionId)
          );
          conn.pendingSync.answered = true;
          conn.syncLiveRevision = revision;
        } else if (!waiting) {
          onResumeRequest?.(sessionId);
          requestSnapshot(sessionId);
        }
      } else if (command.sessionId) {
        // 历史会话在 worker 里没有投影，先请渲染层恢复（与桌面点开会话同路径）。
        conn.pendingSync = undefined;
        conn.pendingSnapshot = true;
        onResumeRequest?.(command.sessionId);
        requestSnapshot(command.sessionId);
      } else {
        conn.pendingSync = undefined;
      }
      // 切换订阅后目录要重裁（cwd/排队/目标只挂当前会话）
      requestMeta(conn);
      break;
    }
    case 'snapshot':
      // 只要目录；会话正文走 subscribe。peer-joined 已经 forget 过 catalog，
      // 这里再 forget 会把刚发出的 14kB 瘦目录再打一遍。
      resyncGuestMeta(conn, false);
      break;
    case 'set-model': {
      const check = checkSetModel(command, whitelist);
      if (!check.ok) {
        console.warn(`[pair] set-model rejected: ${check.error}`);
        return;
      }
      onSessionConfig?.(command);
      break;
    }
    case 'set-reasoning':
    case 'set-thinking':
      // 结构已校验；store 的 setReasoning/setThinking 自带「已启动会话即时下发」逻辑
      onSessionConfig?.(command);
      break;
    case 'enqueue':
    case 'queue-remove':
    case 'queue-update':
    case 'queue-send-now':
    case 'queue-interrupt-send':
    case 'goal-pause':
    case 'goal-resume':
    case 'goal-clear':
    case 'goal-set':
    case 'compact':
    case 'rewind':
    case 'retry':
    case 'task-stop':
    case 'subagent-stop':
      // 结构已校验；交 renderer 的会话 store / electronAPI（与桌面同一路径）
      onQueueAction?.(command);
      break;
    case 'history':
      // 只服务当前订阅会话：其它会话的正文本就不该下发
      if (command.sessionId !== conn.subscribedId) return;
      conn.pendingHistory = command.beforeIndex;
      requestSnapshot(command.sessionId);
      break;
    case 'push-subscribe':
      setPushSubscription(conn.device.pairId, command.subscription);
      break;
    case 'push-unsubscribe':
      clearPushSubscription(conn.device.pairId);
      break;
    case 'presence':
      conn.phoneVisible = command.visible;
      break;
    case 'direct-offer':
    case 'direct-ice':
    case 'direct-close':
      conn.direct.handleSignal(command);
      break;
    case 'probe':
      // 测速必须走中继，走直连会测到 DC 而不是中继路径
      void enqueueSend(conn, { type: 'probe-ack', nonce: command.nonce }, true);
      break;
    case 'spawn': {
      const check = checkSpawn(command, whitelist);
      if (!check.ok) {
        console.warn(`[pair] spawn rejected: ${check.error}`);
        return;
      }
      const result = (await agentBridge?.spawn({
        sessionId: command.sessionId,
        providerId: command.providerId,
        modelId: command.modelId,
        cwd: check.resolved.cwd,
        ...(command.presetId ? { presetId: command.presetId } : {}),
        ...(command.approvalMode ? { approvalMode: command.approvalMode } : {}),
        ...(command.reasoningEnabled ? { reasoningEnabled: true } : {}),
        ...(command.thinkingLevel ? { thinkingLevel: command.thinkingLevel } : {}),
      })) ?? { ok: false, error: 'pair agent bridge is not wired' };
      if (!connectionCurrent(conn, generation, ioEpoch)) return;
      if (!result.ok) {
        console.warn(`[pair] spawn failed: ${result.error}`);
        break;
      }
      conn.syncRevision++;
      conn.pendingSync = undefined;
      conn.syncLiveRevision = undefined;
      conn.subscribedId = command.sessionId;
      /*
       * 会话已在 worker 侧起来，但 renderer 的 store 里没有它——桌面列表看不到，
       * 且它的 agent 事件会因「未知会话」被直接丢弃。这里请 renderer 补登记。
       */
      onSessionCreated?.({
        sessionId: command.sessionId,
        projectId: command.projectId,
        providerId: command.providerId,
        modelId: command.modelId,
        reasoningEnabled: command.reasoningEnabled ?? false,
        ...(command.thinkingLevel ? { thinkingLevel: command.thinkingLevel } : {}),
        ...(command.presetId ? { presetId: command.presetId } : {}),
        ...(command.approvalMode ? { approvalMode: command.approvalMode } : {}),
      });
      break;
    }
  }
  syncPinnedSessions();
}

// ── 发：加密下行 ──────────────────────────────────────────────────────

type SendGuard = () => boolean;

async function sendNow(
  conn: Connection,
  message: HostToPhone | DirectSignal,
  relayOnly: boolean,
  generation: number,
  ioEpoch: number,
  guard?: SendGuard
): Promise<boolean> {
  if (!connectionCurrent(conn, generation, ioEpoch) || (guard && !guard())) return false;
  if (
    relayOnly
      ? conn.ws?.readyState !== 1
      : conn.direct.transport() !== 'direct' && conn.ws?.readyState !== 1
  ) {
    return false;
  }
  if (!relayOnly && message.type === 'providers') {
    const fp = providersSyncFingerprint(message.providers);
    if (sentProviderFp.get(conn.device.pairId) === fp) return true;
    sentProviderFp.set(conn.device.pairId, fp);
  }
  const releaseProviderFp = (): void => {
    if (!relayOnly && message.type === 'providers') sentProviderFp.delete(conn.device.pairId);
  };
  try {
    const frame = await sealFrame(conn.contentKey, message);
    if (!connectionCurrent(conn, generation, ioEpoch) || (guard && !guard())) {
      releaseProviderFp();
      return false;
    }
    // 中继对超过 1MB 的帧直接丢弃且不通知发送方：本地拦下并留痕，别白发（直连同限，分片上限对齐）
    if (frame.byteLength >= 1_000_000) {
      console.warn(`[pair] frame ${frame.byteLength}B over relay limit, dropped locally`);
      releaseProviderFp();
      return false;
    }
    // 直连优先；背压/刚好断掉时无缝退回中继。信令始终只走中继。
    if (!relayOnly && conn.direct.send(frame)) return true;
    const ok = sendFrameViaRelay(conn, frame);
    if (!ok) releaseProviderFp();
    return ok;
  } catch (error) {
    releaseProviderFp();
    console.warn('[pair] send failed', error);
    return false;
  }
}

function enqueueSend(
  conn: Connection,
  message: HostToPhone | DirectSignal,
  relayOnly: boolean,
  guard?: SendGuard
): Promise<boolean> {
  const generation = conn.generation;
  const ioEpoch = conn.ioEpoch;
  const task = conn.sendQueue.then(() =>
    sendNow(conn, message, relayOnly, generation, ioEpoch, guard)
  );
  conn.sendQueue = task.then(
    () => undefined,
    () => undefined
  );
  return task;
}

function send(conn: Connection, message: HostToPhone, guard?: SendGuard): Promise<boolean> {
  return enqueueSend(conn, message, false, guard);
}

function sendFrameViaRelay(conn: Connection, frame: Uint8Array): boolean {
  const ws = conn.ws;
  if (ws?.readyState !== 1) return false;
  ws.send(new Uint8Array(frame).slice().buffer as ArrayBuffer);
  return true;
}

/** 直连信令只能走中继（直连未建/已坏时信令就是为了修它） */
async function sendViaRelay(conn: Connection, message: DirectSignal): Promise<void> {
  await enqueueSend(conn, message, true);
}

function requestMeta(conn: Connection): void {
  requestPairMeta(conn, sendMeta);
}

function scheduleProvidersResync(conn: Connection, delayMs: number): void {
  if (conn.closed || conn.providersRetry) return;
  conn.providersRetry = setTimeout(() => {
    conn.providersRetry = null;
    if (conn.closed || !conn.phoneOnline) return;
    requestMeta(conn);
  }, delayMs);
}

/** 进房重发目录/项目/模型表/推送配置。 */
function resyncGuestMeta(conn: Connection, forgetCatalog = true): void {
  if (forgetCatalog && !conn.metaSending) {
    conn.sentMeta = forgetGuestSyncMeta(conn.sentMeta);
    const next = forgetGuestSyncMeta(stableMetaByPair.get(conn.device.pairId));
    if (next) stableMetaByPair.set(conn.device.pairId, next);
    else stableMetaByPair.delete(conn.device.pairId);
    sentProviderFp.delete(conn.device.pairId);
    conn.providersSentFp = undefined;
    conn.providersSentAt = undefined;
  }
  requestMeta(conn);
}

async function sendMeta(conn: Connection): Promise<void> {
  const appearance = {
    type: 'appearance' as const,
    theme,
    ...(terminal ? { terminal } : {}),
    ...(terminalFontFamily ? { terminalFontFamily } : {}),
    compactReadOnlyTools,
    expandLiveEdits,
    ...timelinePrefs,
  };
  const vapidPublicKey = getVapidPublicKey();
  const directReady = PAIR_DIRECT_ENABLED && isDirectPeerAvailable();
  const hostInfo = {
    hostname: os.hostname(),
    appVersion: app.getVersion(),
    ...(directReady ? { capabilities: ['direct-v1' as const], iceServers: PAIR_STUN_SERVERS } : {}),
  };
  const catalogEntries = slimCatalogForPhone(catalog, conn.subscribedId);
  const projectEntries = slimProjectsForPhone(projects);
  const next: PairMetaFingerprints = {
    catalog: catalogSyncFingerprint(catalogEntries, pinnedOrder),
    projects: pairJsonFingerprint({ projects: projectEntries, groups: projectGroups }),
    ...(providersSettled ? { providers: providersSyncFingerprint(providers) } : {}),
    appearance: pairJsonFingerprint(appearance),
    pushConfig: pairJsonFingerprint(vapidPublicKey),
    hostInfo: pairJsonFingerprint(hostInfo),
  };
  // renderer 尚未推过目录时扣下 renderer-owned 通道（catalog/projects/providers/appearance）：
  // host 重启后 guest 往往已在房里，peer-joined 先于 renderer 首推到达，空 catalog 当真目录发出去
  // 会让 guest 把仍在订阅的会话误判为幽灵。被扣下的通道不进 next，flushChangedMeta 只记实际发出的。
  const last = mergeStableMeta(stableMetaByPair.get(conn.device.pairId), conn.sentMeta);
  const providerPlan = next.providers
    ? planProviderEmit(conn.providersSentFp, conn.providersSentAt, next.providers, Date.now())
    : ({ kind: 'unchanged' } as const);
  const emit = providerChannelsToSend(channelsForMetaPush(last, next, catalogReady), providerPlan);
  if (emit.deferMs !== undefined) scheduleProvidersResync(conn, emit.deferMs);
  const allowed = new Set(emit.channels);
  const remembered = rememberStableMeta(stableMetaByPair.get(conn.device.pairId), allowed, next);
  if (remembered) stableMetaByPair.set(conn.device.pairId, remembered);
  const gated: PairMetaFingerprints = {};
  for (const key of allowed) gated[key] = next[key];
  await flushChangedMeta(
    last,
    gated,
    {
      catalog: () => send(conn, { type: 'catalog', entries: catalogEntries, pinnedOrder }),
      projects: () =>
        send(conn, {
          type: 'projects',
          projects: projectEntries,
          ...(projectGroups.length > 0 ? { groups: projectGroups } : {}),
        }),
      providers: async () => {
        const fp = next.providers ?? providersSyncFingerprint(providers);
        const now = Date.now();
        const plan = planProviderEmit(conn.providersSentFp, conn.providersSentAt, fp, now);
        if (plan.kind === 'unchanged') return true;
        if (plan.kind === 'defer') {
          scheduleProvidersResync(conn, plan.delayMs);
          return false;
        }
        const ok = await send(conn, { type: 'providers', providers });
        if (ok) {
          conn.providersSentFp = fp;
          conn.providersSentAt = now;
          if (conn.providersRetry) {
            clearTimeout(conn.providersRetry);
            conn.providersRetry = null;
          }
        }
        return ok;
      },
      appearance: () => send(conn, appearance),
      pushConfig: () => send(conn, { type: 'push-config', vapidPublicKey }),
      hostInfo: () => send(conn, { type: 'host-info', ...hostInfo }),
    },
    conn
  );
}

interface PairSnapshotSession {
  sessionId?: string;
  identity?: { sessionId?: string; generation?: string };
  messages?: unknown[];
}

function forwardSnapshot(event: RendererAgentEvent): void {
  const full = event as { type: string; sessions?: PairSnapshotSession[] };
  const baselines = new Map<string, { cursor: PairSyncCursor; rotated: boolean }>();
  for (const session of full.sessions ?? []) {
    const sessionId = session.identity?.sessionId ?? session.sessionId;
    if (!sessionId) continue;
    const previous = replayLog.cursorOf(sessionId);
    const snapshot = narrowSnapshot({ type: 'snapshot', sessions: [session] }, sessionId) ?? {
      type: 'snapshot' as const,
      sessions: [{ ...session, sessionId }],
    };
    const cursor = replayLog.checkpoint(sessionId, snapshot, session.identity?.generation);
    baselines.set(sessionId, {
      cursor,
      rotated: !previous || previous.epoch !== cursor.epoch,
    });
  }

  for (const conn of connections.values()) {
    if (!conn.phoneOnline || !conn.subscribedId) continue;
    const subscribedId = conn.subscribedId;
    const revision = conn.syncRevision;
    const session = full.sessions?.find(
      (candidate) => (candidate.identity?.sessionId ?? candidate.sessionId) === subscribedId
    );
    const sync = conn.pendingSync;
    if (conn.pendingHistory !== undefined) {
      if (session && Array.isArray(session.messages)) {
        const page = sliceHistory(session.messages, conn.pendingHistory);
        void send(
          conn,
          {
            type: 'history',
            sessionId: subscribedId,
            baseIndex: page.baseIndex,
            messages: page.messages,
          },
          () => conn.syncRevision === revision && conn.subscribedId === subscribedId
        );
      }
      conn.pendingHistory = undefined;
      if (!(sync?.sessionId === subscribedId && !sync.answered)) {
        continue;
      }
    }

    const narrowed = narrowSnapshot(full, subscribedId);
    const baseline = baselines.get(subscribedId);
    if (narrowed && baseline && sync?.sessionId === subscribedId && !sync.answered) {
      conn.syncLiveRevision = sync.revision;
      conn.sinceIndex = undefined;
      conn.pendingSnapshot = undefined;
      sync.answered = true;
      void send(
        conn,
        {
          type: 'session-sync',
          sessionId: subscribedId,
          requestId: sync.requestId,
          cursor: baseline.cursor,
          mode: 'snapshot',
          snapshot: narrowed,
        },
        () => isCurrentSync(conn, sync.revision, subscribedId)
      );
      continue;
    }

    if (baseline?.rotated && conn.syncCapable) {
      void send(
        conn,
        {
          type: 'agent-event',
          event: { type: 'session-invalidated', sessionId: subscribedId },
          cursor: baseline.cursor,
        },
        () => conn.syncRevision === revision && conn.subscribedId === subscribedId
      );
      continue;
    }

    if (!shouldRelayPairSnapshot(conn) || !narrowed) continue;
    // 旧端仍收原 agent-event snapshot；新协议不用 sinceIndex 猜增量。
    conn.sinceIndex = undefined;
    conn.pendingSnapshot = undefined;
    void send(
      conn,
      { type: 'agent-event', event: narrowed },
      () => conn.syncRevision === revision && conn.subscribedId === subscribedId
    );
  }
}

/** agentHost 事件出口：所有会话事件先入日志，再按订阅规则下发。 */
export function forwardAgentEvent(event: RendererAgentEvent): void {
  runningTaskIds = applyPairPowerTaskEvent(runningTaskIds, event);
  syncPowerBlocker();
  const e = event as {
    type: string;
    sessionId?: string;
    identity?: { sessionId?: string };
    index?: number;
  };
  if (e.type === 'snapshot') {
    forwardSnapshot(event);
    return;
  }
  if (e.type === 'worker-exited') replayLog.invalidateAll();
  const recorded = replayLog.record(event);
  // worker 新格式把会话归属嵌在 identity 里；日志和下行都补扁平 sessionId。
  const flatSessionId = recorded?.sessionId ?? e.identity?.sessionId ?? e.sessionId;
  const outgoingEvent =
    recorded?.event ?? (flatSessionId ? { ...event, sessionId: flatSessionId } : event);

  for (const conn of connections.values()) {
    // 离线或锁屏/切后台（socket 半开不算离线）都转系统推送，只发通用文案
    if (!conn.phoneOnline || !conn.phoneVisible) {
      if (hasPushSubscription(conn.device.pairId)) {
        const payload = buildPushPayload(
          e,
          catalog.find((entry) => entry.id === flatSessionId)?.title,
          readNotifyMainAgentOnly()
        );
        if (payload) void sendPush(conn.device.pairId, payload);
      }
      if (!conn.phoneOnline) continue;
    }
    // snapshot/replay 响应已先入发送队列；在途期间不让被快照覆盖的会话事件抢跑。
    const sync = conn.pendingSync;
    if (sync && flatSessionId === conn.subscribedId && conn.syncLiveRevision !== sync.revision) {
      continue;
    }
    // 时间线被截断：后续同 index 重建的消息必须放行
    if (e.type === 'messages-truncated' && flatSessionId === conn.subscribedId) {
      conn.sinceIndex = undefined;
    }
    if (!shouldForward(e, conn.subscribedId, conn.sinceIndex)) continue;
    const revision = conn.syncRevision;
    const subscribedId = conn.subscribedId;
    void send(
      conn,
      {
        type: 'agent-event',
        event: outgoingEvent,
        ...(conn.syncCapable && recorded && recorded.sessionId === subscribedId
          ? { cursor: recorded.cursor }
          : {}),
      },
      () => conn.syncRevision === revision && conn.subscribedId === subscribedId
    );
  }
}

/** renderer 推来的目录/项目/provider（provider 已剥 apiKey/baseUrl） */
export function updatePairCatalog(payload: {
  catalog: CatalogEntry[];
  pinnedOrder?: string[];
  projects: ProjectEntry[];
  projectGroups?: ProjectGroupEntry[];
  providers: ProviderEntry[];
  projectPaths: { id: string; path: string }[];
  theme: HostAppearance;
  terminal?: TerminalPalette;
  terminalFontFamily?: string;
  compactReadOnlyTools?: boolean;
  expandLiveEdits?: boolean;
  expandLiveReasoning?: boolean;
  autoCollapseTurns?: boolean;
  collapseCompletedActivity?: boolean;
  pinUnfinishedTodos?: boolean;
  /** false：OAuth 暂态空列表，不能覆盖上一份真列表，也不能下发 */
  providersSettled?: boolean;
}): void {
  catalog = payload.catalog;
  catalogReady = true;
  pinnedOrder = payload.pinnedOrder ?? [];
  projects = payload.projects;
  projectGroups = payload.projectGroups ?? [];
  theme = payload.theme;
  terminal = payload.terminal;
  terminalFontFamily = payload.terminalFontFamily;
  compactReadOnlyTools = payload.compactReadOnlyTools !== false;
  expandLiveEdits = payload.expandLiveEdits !== false;
  timelinePrefs = normalizeTimelinePrefs(payload);
  if (payload.providersSettled !== false) {
    providers = payload.providers;
    providersSettled = true;
  }
  whitelist = {
    projects: payload.projectPaths,
    providers: (payload.providersSettled === false ? providers : payload.providers).map((p) => ({
      id: p.id,
      models: p.models.map((m) => ({ id: m.id })),
    })),
  };
  for (const conn of connections.values()) {
    // 人对端在房才推：readyState 开着但 peer-left 时往 relay 白发且会误记 sentMeta
    if (conn.phoneOnline) requestMeta(conn);
  }
}

export function getPairCatalog(): CatalogEntry[] {
  return catalog;
}

export function getPairProjects(): ProjectEntry[] {
  return projects;
}

export function mutatePairCatalog(mutate: (entries: CatalogEntry[]) => CatalogEntry[]): void {
  if (!catalogReady) return;
  catalog = mutate(catalog);
  for (const conn of connections.values()) {
    if (conn.phoneOnline) requestMeta(conn);
  }
}
