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
  type PairMetaFingerprints,
  pairJsonFingerprint,
  shouldRelayPairSnapshot,
  slimCatalogForPhone,
  slimProjectsForPhone,
} from '@shared/pair/metaSync';
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
// 会话命令一律走 agentBridge（身份解析留在 ipc/agent.ts），这里只留无需身份的 snapshot。
import { requestSnapshot, setPinnedSessions } from './agentHost';
import { MacosSystemSleepAssertion } from './macosSystemSleepAssertion';
import { readNotifyMainAgentOnly } from './notifications';
import { PAIR_DIRECT_ENABLED, PAIR_STUN_SERVERS } from './pairDirectConfig';
import { isDirectPeerAvailable, mainDirectPeerFactory, preloadDirectPeer } from './pairDirectPeer';
import { bumpPairMetaEpoch, flushChangedMeta, requestPairMeta } from './pairMetaFlush';
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
import { applyPairPowerTaskEvent, shouldHoldPairPowerKeepAlive } from './pairPowerKeepAlive';
import { seedRelayHostCache } from './pairRelayLookup';
import { openPairRelayWebSocket } from './pairRelayOpen';
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
  /** 已下发 meta 各通道指纹；相同内容不重发 */
  sentMeta?: PairMetaFingerprints;
  metaDirty: boolean;
  metaSending: boolean;
  metaEpoch?: number;
  phoneOnline: boolean;
  /** 手机页面可见性（presence 帧上报）：锁屏/切后台时 socket 半开不会 close，推送据此门控 */
  phoneVisible: boolean;
  attempt: number;
  timer: NodeJS.Timeout | null;
  closed: boolean;
  generation: number;
}

const connections = new Map<string, Connection>();
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
/** 桌面外观偏好，随目录下发给手机作为默认值 */
let theme: HostAppearance = 'system';
/** 桌面终端配色（bash 输出用），随外观一起下发 */
let terminal: TerminalPalette | undefined;
let terminalFontFamily: string | undefined;
let compactReadOnlyTools = true;
let expandLiveEdits = true;
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
const macosSystemSleepAssertion = new MacosSystemSleepAssertion();
let runningTaskIds = new Set<string>();

/**
 * 手机在线或任务在跑时阻止 idle 休眠（屏幕仍可熄）。
 * 任务在跑也锁：手机切后台后 socket 常断，不锁会睡死、任务和重连一起没。
 * macOS 额外请求 caffeinate -i -s：尝试挡住系统睡 / 合盖睡（插电才有 -s；合盖仍可能被系统强制睡）。
 */
function syncPowerBlocker(): void {
  const anyOnline = [...connections.values()].some((c) => c.phoneOnline);
  const shouldBlock = shouldHoldPairPowerKeepAlive(anyOnline, runningTaskIds.size);
  if (shouldBlock) {
    if (powerBlockerId === null) {
      powerBlockerId = powerSaveBlocker.start('prevent-app-suspension');
    }
    macosSystemSleepAssertion.start('pair-keep-alive');
  } else {
    if (powerBlockerId !== null) {
      powerSaveBlocker.stop(powerBlockerId);
      powerBlockerId = null;
    }
    macosSystemSleepAssertion.stop('pair-keep-alive');
  }
}

function notifyStatus(): void {
  // phoneOnline 的每次变化都会走到这里，顺带同步休眠锁
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
    if (shouldReplaceOnNudge(reason, conn.ws !== null)) {
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
    if (conn.timer) clearTimeout(conn.timer);
    conn.heartbeat?.stop();
    conn.heartbeat = null;
    conn.direct.close();
    try {
      conn.ws?.close();
    } catch {}
  }
  connections.clear();
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
      };
    }),
  };
}

// ── 连接与重连 ────────────────────────────────────────────────────────

function openConnection(device: PairedDevice): void {
  const existing = connections.get(device.pairId);
  if (existing) {
    existing.closed = true;
    if (existing.timer) clearTimeout(existing.timer);
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
    phoneVisible: true,
    attempt: 0,
    timer: null,
    closed: false,
    generation: 0,
  };
  conn.direct = new DirectLink({
    role: 'host',
    factory: PAIR_DIRECT_ENABLED && isDirectPeerAvailable() ? mainDirectPeerFactory : null,
    iceServers: PAIR_STUN_SERVERS,
    // 信令只走中继：绕过 send() 的出口选择
    sendSignal: (signal) => void sendViaRelay(conn, signal),
    onFrame: (frame) => void handleFrame(conn, frame),
    onTransportChange: (transport) => {
      // 直连掉了且中继也不在：两条路都没了才算离线，转系统推送
      if (transport === 'relay' && conn.ws?.readyState !== 1) conn.phoneOnline = false;
      notifyStatus();
    },
    // 切通道的瞬间旧通道在途帧可能丢：目录类重推，会话正文由手机自己 subscribe 补
    onResync: () => {
      bumpPairMetaEpoch(conn);
      requestMeta(conn);
    },
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
    conn.heartbeat?.stop();
    conn.heartbeat = null;
    conn.ws = null;
    // 直连还活着就不算手机离线：业务帧继续走 DataChannel（直连再掉时由 onTransportChange 补置离线）
    if (conn.direct.transport() !== 'direct') conn.phoneOnline = false;
    // 1008 = 中继明确告知凭据已失效（解绑时下发，或带失效凭据重连时下发）。
    // 不能只看「连不上」就放弃，那是正常的网络波动，仍需重连。
    if (code === 1008) {
      dropRevoked(conn);
      return;
    }
    notifyStatus();
    scheduleReconnect(conn);
  };
  conn.heartbeat = attachHeartbeat(ws, () => {
    try {
      ws.close();
    } catch {}
    closed(null);
  });

  ws.onopen = () => {
    conn.attempt = 0;
    notifyStatus();
  };

  ws.onmessage = (event) => {
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
            conn.subscribedId = null;
            conn.pendingSnapshot = undefined;
            conn.pendingHistory = undefined;
          }
          bumpPairMetaEpoch(conn);
          // 手机进房即推目录（它也会发 snapshot，指纹相同则不重发）
          requestMeta(conn);
          notifyStatus();
        } else if (control.type === 'peer-left') {
          conn.phoneOnline = false;
          conn.direct.peerOnline(false);
          notifyStatus();
        } else if (control.type === 'revoked') {
          // 手机端解除了配对：连凭据一起清掉，否则设置页会一直挂着一个连不上的设备
          dropRevoked(conn);
        }
      } catch {}
      return;
    }
    void handleFrame(conn, new Uint8Array(event.data as ArrayBuffer));
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
  const conn = connections.get(pairId);
  if (conn) {
    conn.closed = true;
    if (conn.timer) clearTimeout(conn.timer);
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

async function handleFrame(conn: Connection, frame: Uint8Array): Promise<void> {
  // 收到手机的加密帧即证明它在房间里（控制帧可能因时序丢失）
  if (!conn.phoneOnline) {
    conn.phoneOnline = true;
    bumpPairMetaEpoch(conn);
    notifyStatus();
  }
  let payload: unknown;
  try {
    payload = await openFrame(conn.contentKey, frame);
  } catch {
    console.warn('[pair] frame decrypt failed, dropped');
    return;
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
    case 'subscribe':
      conn.subscribedId = command.sessionId;
      conn.sinceIndex = command.sinceIndex;
      // 换了订阅，旧会话的分页请求作废
      conn.pendingHistory = undefined;
      // 历史会话在 worker 里没有投影，先请渲染层恢复（与桌面点开会话同路径），
      // 再要快照；已启动的会话 resume 会自行忽略。
      if (command.sessionId) {
        conn.pendingSnapshot = true;
        onResumeRequest?.(command.sessionId);
        requestSnapshot(command.sessionId);
      } else {
        conn.pendingSnapshot = undefined;
      }
      // 切换订阅后目录要重裁（cwd/排队只挂当前会话）
      requestMeta(conn);
      break;
    case 'snapshot':
      // 只要目录/外观；会话正文走 subscribe。强制重发：renderer 重载会丢已推 IPC，清指纹后整包重推。
      bumpPairMetaEpoch(conn);
      requestMeta(conn);
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
      // 结构已校验；交 renderer 的会话 store（与桌面队列区同一路径）
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
      if (!result.ok) {
        console.warn(`[pair] spawn failed: ${result.error}`);
        break;
      }
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

async function send(conn: Connection, message: HostToPhone): Promise<boolean> {
  const direct = conn.direct.transport() === 'direct';
  if (!direct && conn.ws?.readyState !== 1) return false;
  try {
    const frame = await sealFrame(conn.contentKey, message);
    // 中继对超过 1MB 的帧直接丢弃且不通知发送方：本地拦下并留痕，别白发（直连同限，分片上限对齐）
    if (frame.byteLength > 1_000_000) {
      console.warn(`[pair] frame ${frame.byteLength}B over relay limit, dropped locally`);
      return false;
    }
    // 直连优先；背压/刚好断掉时无缝退回中继
    if (conn.direct.send(frame)) return true;
    return sendFrameViaRelay(conn, frame);
  } catch (error) {
    console.warn('[pair] send failed', error);
    return false;
  }
}

function sendFrameViaRelay(conn: Connection, frame: Uint8Array): boolean {
  const ws = conn.ws;
  if (ws?.readyState !== 1) return false;
  ws.send(new Uint8Array(frame).slice().buffer as ArrayBuffer);
  return true;
}

/** 直连信令只能走中继（直连未建/已坏时信令就是为了修它） */
async function sendViaRelay(conn: Connection, message: DirectSignal): Promise<void> {
  try {
    sendFrameViaRelay(conn, await sealFrame(conn.contentKey, message as HostToPhone));
  } catch (error) {
    console.warn('[pair] signal send failed', error);
  }
}

function requestMeta(conn: Connection): void {
  requestPairMeta(conn, sendMeta);
}

async function sendMeta(conn: Connection): Promise<void> {
  const appearance = {
    type: 'appearance' as const,
    theme,
    ...(terminal ? { terminal } : {}),
    ...(terminalFontFamily ? { terminalFontFamily } : {}),
    compactReadOnlyTools,
    expandLiveEdits,
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
    providers: pairJsonFingerprint(providers),
    appearance: pairJsonFingerprint(appearance),
    pushConfig: pairJsonFingerprint(vapidPublicKey),
    hostInfo: pairJsonFingerprint(hostInfo),
  };
  // renderer 尚未推过目录时扣下 renderer-owned 通道（catalog/projects/providers/appearance）：
  // host 重启后 guest 往往已在房里，peer-joined 先于 renderer 首推到达，空 catalog 当真目录发出去
  // 会让 guest 把仍在订阅的会话误判为幽灵。被扣下的通道不进 next，flushChangedMeta 只记实际发出的。
  const allowed = new Set(channelsForMetaPush(conn.sentMeta, next, catalogReady));
  const gated: PairMetaFingerprints = {};
  for (const key of allowed) gated[key] = next[key];
  await flushChangedMeta(
    conn.sentMeta,
    gated,
    {
      catalog: () => send(conn, { type: 'catalog', entries: catalogEntries, pinnedOrder }),
      projects: () =>
        send(conn, {
          type: 'projects',
          projects: projectEntries,
          ...(projectGroups.length > 0 ? { groups: projectGroups } : {}),
        }),
      providers: () => send(conn, { type: 'providers', providers }),
      appearance: () => send(conn, appearance),
      pushConfig: () => send(conn, { type: 'push-config', vapidPublicKey }),
      hostInfo: () => send(conn, { type: 'host-info', ...hostInfo }),
    },
    conn
  );
}

/** agentHost 事件出口：按订阅过滤后加密发给每台在线手机 */
export function forwardAgentEvent(event: RendererAgentEvent): void {
  runningTaskIds = applyPairPowerTaskEvent(runningTaskIds, event);
  syncPowerBlocker();
  const e = event as {
    type: string;
    sessionId?: string;
    identity?: { sessionId?: string };
    index?: number;
  };
  // worker 新格式把会话归属嵌在 identity 里；手机端按扁平 sessionId 消费
  //（线上 PWA 不随桌面版同步发布），下发前归一化补上
  const flatSessionId = e.identity?.sessionId ?? e.sessionId;
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
    // snapshot 是全量批事件，裁成只含订阅会话再发
    if (e.type === 'snapshot') {
      const full = event as {
        type: string;
        sessions?: {
          sessionId?: string;
          identity?: { sessionId?: string };
          messages?: unknown[];
        }[];
      };
      if (!shouldRelayPairSnapshot(conn)) continue;
      // 有挂起的分页请求：切 beforeIndex 之前的一页发回，不重复发尾窗
      if (conn.pendingHistory !== undefined && conn.subscribedId) {
        const session = full.sessions?.find(
          (s) => (s.identity?.sessionId ?? s.sessionId) === conn.subscribedId
        );
        if (session && Array.isArray(session.messages)) {
          const page = sliceHistory(session.messages, conn.pendingHistory);
          void send(conn, {
            type: 'history',
            sessionId: conn.subscribedId,
            baseIndex: page.baseIndex,
            messages: page.messages,
          });
        }
        conn.pendingHistory = undefined;
        continue;
      }
      const narrowed = narrowSnapshot(full, conn.subscribedId);
      if (narrowed) {
        // 尾窗已覆盖手机所有已知内容，续传游标完成使命；继续拿它过滤会在
        // 截断/压缩后把新消息当旧消息丢掉，手机就「卡住」直到重开
        conn.sinceIndex = undefined;
        conn.pendingSnapshot = undefined;
        void send(conn, { type: 'agent-event', event: narrowed });
      }
      continue;
    }
    // 时间线被截断：后续同 index 重建的消息必须放行
    if (e.type === 'messages-truncated' && flatSessionId === conn.subscribedId) {
      conn.sinceIndex = undefined;
    }
    if (!shouldForward(e, conn.subscribedId, conn.sinceIndex)) continue;
    void send(conn, {
      type: 'agent-event',
      event: flatSessionId ? { ...event, sessionId: flatSessionId } : event,
    });
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
}): void {
  catalog = payload.catalog;
  catalogReady = true;
  pinnedOrder = payload.pinnedOrder ?? [];
  projects = payload.projects;
  projectGroups = payload.projectGroups ?? [];
  providers = payload.providers;
  theme = payload.theme;
  terminal = payload.terminal;
  terminalFontFamily = payload.terminalFontFamily;
  compactReadOnlyTools = payload.compactReadOnlyTools !== false;
  expandLiveEdits = payload.expandLiveEdits !== false;
  whitelist = {
    projects: payload.projectPaths,
    providers: payload.providers.map((p) => ({
      id: p.id,
      models: p.models.map((m) => ({ id: m.id })),
    })),
  };
  for (const conn of connections.values()) {
    // 人对端在房才推：readyState 开着但 peer-left 时往 relay 白发且会误记 sentMeta
    if (conn.phoneOnline) requestMeta(conn);
  }
}
