import {
  attachHeartbeat,
  backoffDelay,
  buildPairLink,
  type CatalogEntry,
  DEFAULT_RELAY_URL,
  fromBase64Url,
  type Heartbeat,
  type HostAppearance,
  type HostPairSession,
  type HostToPhone,
  openFrame,
  type PairedDevice,
  type ProjectEntry,
  type ProviderEntry,
  pollHostPairing,
  revokePairing,
  sealFrame,
  startHostPairing,
  type TerminalPalette,
  toBase64Url,
  toWebSocketUrl,
} from '@enso/pair';
import type { RendererAgentEvent } from '@shared/types/agent';
import type { PairCreatedSession, PairSessionConfig, PairStatus } from '@shared/types/pair';
import { powerMonitor, powerSaveBlocker } from 'electron';
import {
  abortSession,
  promptSession,
  requestSnapshot,
  respondApproval,
  respondAsk,
  spawnSession,
  steerSession,
} from './agentHost';
import {
  checkSetModel,
  checkSpawn,
  narrowSnapshot,
  parsePhoneCommand,
  type SpawnWhitelist,
  shouldForward,
} from './pairPolicy';
import {
  isSecureStorageAvailable,
  loadDevices,
  loadRelayUrl,
  saveDevices,
  saveRelayUrl,
} from './pairStore';

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
}

interface Connection {
  device: PairedDevice;
  contentKey: Uint8Array;
  ws: WebSocket | null;
  heartbeat: Heartbeat | null;
  /** 手机当前订阅的会话（null = 列表页，不收正文） */
  subscribedId: string | null;
  sinceIndex?: number;
  phoneOnline: boolean;
  attempt: number;
  timer: NodeJS.Timeout | null;
  closed: boolean;
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

/** renderer 推上来的目录快照（会话标题/项目/provider 只在 renderer 有） */
let catalog: CatalogEntry[] = [];
let projects: ProjectEntry[] = [];
let providers: ProviderEntry[] = [];
/** 桌面外观偏好，随目录下发给手机作为默认值 */
let theme: HostAppearance = 'system';
/** 桌面终端配色（bash 输出用），随外观一起下发 */
let terminal: TerminalPalette | undefined;
let terminalFontFamily: string | undefined;
/** 剥密前的完整项目路径映射，用于 spawn 反查 cwd */
let whitelist: SpawnWhitelist = { projects: [], providers: [] };

export function setPairStatusListener(listener: () => void): void {
  onStatusChange = listener;
}

export function setPairResumeListener(listener: (sessionId: string) => void): void {
  onResumeRequest = listener;
}

export function setPairSessionCreatedListener(
  listener: (session: PairCreatedSession) => void
): void {
  onSessionCreated = listener;
}

export function setPairSessionConfigListener(listener: (config: PairSessionConfig) => void): void {
  onSessionConfig = listener;
}

let powerBlockerId: number | null = null;

/** 有手机在线时阻止系统 idle 休眠（屏幕仍可熄）：休眠会掐死中继连接，手机端直接失联 */
function syncPowerBlocker(): void {
  const anyOnline = [...connections.values()].some((c) => c.phoneOnline);
  if (anyOnline && powerBlockerId === null) {
    powerBlockerId = powerSaveBlocker.start('prevent-app-suspension');
  } else if (!anyOnline && powerBlockerId !== null) {
    powerSaveBlocker.stop(powerBlockerId);
    powerBlockerId = null;
  }
}

function notifyStatus(): void {
  // phoneOnline 的每次变化都会走到这里，顺带同步休眠锁
  syncPowerBlocker();
  onStatusChange?.();
}

// ── 生命周期 ──────────────────────────────────────────────────────────

let resumeHooked = false;

export function startPairHost(): void {
  if (!resumeHooked) {
    resumeHooked = true;
    // 睡眠唤醒后 TCP 多半已死但 close 事件不会来：活链立即探测，死链立即重连
    powerMonitor.on('resume', probeAll);
  }
  for (const device of loadDevices()) {
    openConnection(device);
  }
}

function probeAll(): void {
  for (const conn of connections.values()) {
    if (conn.closed) continue;
    if (conn.ws) {
      conn.heartbeat?.probe();
    } else {
      if (conn.timer) clearTimeout(conn.timer);
      conn.attempt = 0;
      connect(conn);
    }
  }
}

export function stopPairHost(): void {
  cancelPairing();
  for (const conn of connections.values()) {
    conn.closed = true;
    if (conn.timer) clearTimeout(conn.timer);
    conn.heartbeat?.stop();
    conn.heartbeat = null;
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
        saveDevices([...loadDevices().filter((d) => d.pairId !== device.pairId), device]);
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
    try {
      existing.ws?.close();
    } catch {}
  }
  const conn: Connection = {
    device,
    contentKey: fromBase64Url(device.contentKey),
    ws: null,
    heartbeat: null,
    subscribedId: null,
    phoneOnline: false,
    attempt: 0,
    timer: null,
    closed: false,
  };
  connections.set(device.pairId, conn);
  connect(conn);
}

function connect(conn: Connection): void {
  if (conn.closed) return;
  const base = toWebSocketUrl(conn.device.relayUrl);
  const url = `${base}/v1/pair/${encodeURIComponent(conn.device.pairId)}?role=host&token=${encodeURIComponent(conn.device.token)}`;
  let ws: WebSocket;
  try {
    ws = new WebSocket(url);
  } catch {
    scheduleReconnect(conn);
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
    conn.phoneOnline = false;
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
          conn.subscribedId = null;
          // 手机进房即推目录（它也会发 snapshot，但 main 侧缓存可能更早就绪）
          void sendMeta(conn);
          notifyStatus();
        } else if (control.type === 'peer-left') {
          conn.phoneOnline = false;
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
    try {
      conn.ws?.close();
    } catch {}
    conn.ws = null;
    connections.delete(pairId);
  }
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
      promptSession(command.sessionId, command.text, command.images);
      break;
    case 'steer':
      steerSession(command.sessionId, command.text, command.images);
      break;
    case 'abort':
      abortSession(command.sessionId);
      break;
    case 'approval-respond':
      respondApproval(command.sessionId, command.requestId, command.decision);
      break;
    case 'ask-respond':
      respondAsk(command.sessionId, command.requestId, command.answer);
      break;
    case 'subscribe':
      conn.subscribedId = command.sessionId;
      conn.sinceIndex = command.sinceIndex;
      // 历史会话在 worker 里没有投影，先请渲染层恢复（与桌面点开会话同路径），
      // 再要快照；已启动的会话 resume 会自行忽略。
      if (command.sessionId) onResumeRequest?.(command.sessionId);
      requestSnapshot();
      break;
    case 'snapshot':
      void sendMeta(conn);
      requestSnapshot();
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
    case 'spawn': {
      const check = checkSpawn(command, whitelist);
      if (!check.ok) {
        console.warn(`[pair] spawn rejected: ${check.error}`);
        return;
      }
      const result = spawnSession({
        sessionId: command.sessionId,
        providerId: command.providerId,
        modelId: command.modelId,
        cwd: check.resolved.cwd,
        ...(command.presetId ? { presetId: command.presetId } : {}),
        ...(command.approvalMode ? { approvalMode: command.approvalMode } : {}),
        ...(command.reasoningEnabled ? { reasoningEnabled: true } : {}),
        ...(command.thinkingLevel ? { thinkingLevel: command.thinkingLevel } : {}),
      });
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
}

// ── 发：加密下行 ──────────────────────────────────────────────────────

async function send(conn: Connection, message: HostToPhone): Promise<void> {
  if (conn.ws?.readyState !== 1) return;
  try {
    const frame = await sealFrame(conn.contentKey, message);
    conn.ws.send(new Uint8Array(frame).slice().buffer as ArrayBuffer);
  } catch (error) {
    console.warn('[pair] send failed', error);
  }
}

async function sendMeta(conn: Connection): Promise<void> {
  await send(conn, { type: 'catalog', entries: catalog });
  await send(conn, { type: 'projects', projects });
  await send(conn, { type: 'providers', providers });
  await send(conn, {
    type: 'appearance',
    theme,
    ...(terminal ? { terminal } : {}),
    ...(terminalFontFamily ? { terminalFontFamily } : {}),
  });
}

/** agentHost 事件出口：按订阅过滤后加密发给每台在线手机 */
export function forwardAgentEvent(event: RendererAgentEvent): void {
  const e = event as { type: string; sessionId?: string; index?: number };
  for (const conn of connections.values()) {
    if (!conn.phoneOnline) continue;
    // snapshot 是全量批事件，裁成只含订阅会话再发
    if (e.type === 'snapshot') {
      const narrowed = narrowSnapshot(
        event as { type: string; sessions?: { sessionId: string }[] },
        conn.subscribedId
      );
      if (narrowed) void send(conn, { type: 'agent-event', event: narrowed });
      continue;
    }
    if (!shouldForward(e, conn.subscribedId, conn.sinceIndex)) continue;
    void send(conn, { type: 'agent-event', event });
  }
}

/** renderer 推来的目录/项目/provider（provider 已剥 apiKey/baseUrl） */
export function updatePairCatalog(payload: {
  catalog: CatalogEntry[];
  projects: ProjectEntry[];
  providers: ProviderEntry[];
  projectPaths: { id: string; path: string }[];
  theme: HostAppearance;
  terminal?: TerminalPalette;
  terminalFontFamily?: string;
}): void {
  catalog = payload.catalog;
  projects = payload.projects;
  providers = payload.providers;
  theme = payload.theme;
  terminal = payload.terminal;
  terminalFontFamily = payload.terminalFontFamily;
  whitelist = {
    projects: payload.projectPaths,
    providers: payload.providers.map((p) => ({
      id: p.id,
      models: p.models.map((m) => ({ id: m.id })),
    })),
  };
  for (const conn of connections.values()) {
    // 连接已建立就发：phoneOnline 依赖控制帧，时序上可能晚于目录更新
    if (conn.ws?.readyState === 1) void sendMeta(conn);
  }
}
