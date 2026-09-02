import os from 'node:os';
import {
  attachHeartbeat,
  backoffDelay,
  claimPairing,
  fromBase64Url,
  type Heartbeat,
  type HostToPhone,
  openFrame,
  type PairedDevice,
  type PhoneToHost,
  parsePairUri,
  revokePairing,
  sealFrame,
  toBase64Url,
  toWebSocketUrl,
} from '@enso/pair';
import type {
  NodeActionResult,
  NodeMessage,
  NodePairResult,
  NodesStatus,
  RemoteNodeStatus,
} from '@shared/types/nodes';
import { powerMonitor, safeStorage } from 'electron';
import {
  loadNodes,
  type RemoteNode,
  removeNode as removeFromList,
  renameNode as renameInList,
  saveNodes,
  upsertNode,
} from './nodeStore';

/**
 * 「连接到节点」guest 端：本机连到别的 EnsoCode 桌面（对方是 pairHost）。
 * 与 pairHost 对称——每个节点一条 role=guest 的 WSS、心跳、退避重连、解密后推 renderer。
 * 密钥与连接都留在 main：渲染层刷新不掉线，contentKey 不进渲染层。
 */

interface Connection {
  node: RemoteNode;
  contentKey: Uint8Array;
  ws: WebSocket | null;
  heartbeat: Heartbeat | null;
  hostOnline: boolean;
  hostname?: string;
  appVersion?: string;
  attempt: number;
  timer: NodeJS.Timeout | null;
  closed: boolean;
}

const connections = new Map<string, Connection>();
let onStatusChange: ((status: NodesStatus) => void) | null = null;
let onMessage: ((message: NodeMessage) => void) | null = null;

export function setNodesStatusListener(listener: (status: NodesStatus) => void): void {
  onStatusChange = listener;
}

export function setNodesMessageListener(listener: (message: NodeMessage) => void): void {
  onMessage = listener;
}

function isSecureStorageAvailable(): boolean {
  try {
    return safeStorage.isEncryptionAvailable();
  } catch {
    return false;
  }
}

export function getNodesStatus(): NodesStatus {
  return {
    nodes: loadNodes().map((node): RemoteNodeStatus => {
      const conn = connections.get(node.nodeId);
      return {
        nodeId: node.nodeId,
        label: node.label,
        relayUrl: node.relayUrl,
        pairedAt: node.pairedAt,
        connected: conn?.ws?.readyState === 1,
        hostOnline: conn?.hostOnline ?? false,
        ...(conn?.hostname ? { hostname: conn.hostname } : {}),
        ...(conn?.appVersion ? { appVersion: conn.appVersion } : {}),
      };
    }),
    secureStorage: isSecureStorageAvailable(),
  };
}

function notifyStatus(): void {
  onStatusChange?.(getNodesStatus());
}

// ── 生命周期 ──────────────────────────────────────────────────────────

let resumeHooked = false;

export function startPairGuest(): void {
  if (!resumeHooked) {
    resumeHooked = true;
    // 睡眠唤醒后 TCP 多半已死但 close 事件不会来：活链立即探测，死链立即重连
    powerMonitor.on('resume', probeAll);
  }
  for (const node of loadNodes()) openConnection(node);
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

export function stopPairGuest(): void {
  for (const conn of connections.values()) closeConnection(conn);
  connections.clear();
}

function closeConnection(conn: Connection): void {
  conn.closed = true;
  if (conn.timer) clearTimeout(conn.timer);
  conn.heartbeat?.stop();
  conn.heartbeat = null;
  try {
    conn.ws?.close();
  } catch {}
  conn.ws = null;
}

// ── 配对 / 解绑 / 重命名 ──────────────────────────────────────────────

/** 粘贴对方的配对链接：认领 → 存凭据 → 立即连接。deviceName 报本机主机名，对方设备列表据此区分手机与电脑 */
export async function pairNode(inviteUri: string): Promise<NodePairResult> {
  let invite: ReturnType<typeof parsePairUri>;
  try {
    invite = parsePairUri(inviteUri);
  } catch {
    return { ok: false, error: 'invalid-uri' };
  }
  let claimed: Awaited<ReturnType<typeof claimPairing>>;
  try {
    claimed = await claimPairing(invite.relay, invite.publicKey, os.hostname());
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    // postJson 对 4xx 直接抛业务错误（如已被认领/过期），网络失败抛 fetch 错误
    const businessReject = /relay 4\d\d|not found|expired|claimed|authorized/i.test(detail);
    return { ok: false, error: businessReject ? 'expired-or-claimed' : 'relay-unreachable', detail };
  }
  const device: PairedDevice = {
    pairId: claimed.pairId,
    token: claimed.deviceToken,
    contentKey: toBase64Url(claimed.contentKey),
    deviceName: os.hostname(),
    relayUrl: invite.relay,
    pairedAt: Date.now(),
  };
  const list = upsertNode(loadNodes(), device, undefined);
  saveNodes(list);
  const node = list.find((n) => n.nodeId === device.pairId);
  if (!node) return { ok: false, error: 'relay-unreachable', detail: 'store failed' };
  openConnection(node);
  notifyStatus();
  const status = getNodesStatus().nodes.find((n) => n.nodeId === node.nodeId);
  return status
    ? { ok: true, node: status }
    : { ok: false, error: 'relay-unreachable', detail: 'status missing' };
}

/** 解绑：通知中继清房（对方重连即被拒）+ 本地清凭据 + 断连接 */
export async function removeNode(nodeId: string): Promise<NodeActionResult> {
  const node = loadNodes().find((n) => n.nodeId === nodeId);
  if (!node) return { ok: false, error: 'node not found' };
  try {
    await revokePairing(node.relayUrl, node.pairId, node.token);
  } catch {
    // 已被对端解绑或中继不可达：本地照样清
  }
  forgetNode(nodeId);
  notifyStatus();
  return { ok: true };
}

export function renameNode(nodeId: string, label: string): NodeActionResult {
  const list = loadNodes();
  if (!list.some((n) => n.nodeId === nodeId)) return { ok: false, error: 'node not found' };
  const next = renameInList(list, nodeId, label);
  saveNodes(next);
  const conn = connections.get(nodeId);
  if (conn) conn.node = next.find((n) => n.nodeId === nodeId) ?? conn.node;
  notifyStatus();
  return { ok: true };
}

function forgetNode(nodeId: string): void {
  const conn = connections.get(nodeId);
  if (conn) {
    closeConnection(conn);
    connections.delete(nodeId);
  }
  saveNodes(removeFromList(loadNodes(), nodeId));
}

// ── 连接 ──────────────────────────────────────────────────────────────

function openConnection(node: RemoteNode): void {
  const existing = connections.get(node.nodeId);
  if (existing) {
    // 重新配对同一节点（凭据换了）：先断旧的
    closeConnection(existing);
    connections.delete(node.nodeId);
  }
  const conn: Connection = {
    node,
    contentKey: fromBase64Url(node.contentKey),
    ws: null,
    heartbeat: null,
    hostOnline: false,
    attempt: 0,
    timer: null,
    closed: false,
  };
  connections.set(node.nodeId, conn);
  connect(conn);
}

function connect(conn: Connection): void {
  if (conn.closed) return;
  const base = toWebSocketUrl(conn.node.relayUrl);
  const url = `${base}/v1/pair/${encodeURIComponent(conn.node.pairId)}?role=guest&token=${encodeURIComponent(conn.node.token)}`;
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
    conn.hostOnline = false;
    // 1008 = 中继明确告知凭据已失效（对方解绑）。网络波动不是 1008，仍需重连。
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
        if (control.type === 'host-online') {
          conn.hostOnline = true;
          notifyStatus();
          // 进房即要目录（host 收 peer-joined 也会推，双保险防时序丢帧）
          void sendFrame(conn, { type: 'snapshot' });
        } else if (control.type === 'host-offline') {
          conn.hostOnline = false;
          notifyStatus();
        } else if (control.type === 'revoked') {
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

/** 配对已被对端解除：清干净并通知渲染层，不再重连 */
function dropRevoked(conn: Connection): void {
  forgetNode(conn.node.nodeId);
  notifyStatus();
}

function scheduleReconnect(conn: Connection): void {
  if (conn.closed) return;
  if (conn.timer) clearTimeout(conn.timer);
  const delay = backoffDelay(conn.attempt++);
  conn.timer = setTimeout(() => connect(conn), delay);
}

// ── 收：解密 → 过滤 → 推 renderer ────────────────────────────────────

async function handleFrame(conn: Connection, frame: Uint8Array): Promise<void> {
  // 收到加密帧即证明对方在房间里（控制帧可能因时序丢失）
  if (!conn.hostOnline) {
    conn.hostOnline = true;
    notifyStatus();
  }
  let payload: HostToPhone;
  try {
    payload = (await openFrame(conn.contentKey, frame)) as HostToPhone;
  } catch {
    console.warn('[nodes] frame decrypt failed, dropped');
    return;
  }
  if (typeof payload !== 'object' || payload === null || typeof payload.type !== 'string') return;
  switch (payload.type) {
    case 'host-info':
      conn.hostname = payload.hostname;
      conn.appVersion = payload.appVersion;
      notifyStatus();
      return;
    // 桌面保留自己的主题；桌面没有 Web Push
    case 'appearance':
    case 'push-config':
      return;
    default:
      onMessage?.({ nodeId: conn.node.nodeId, payload });
  }
}

// ── 发：加密上行 ──────────────────────────────────────────────────────

async function sendFrame(conn: Connection, command: PhoneToHost): Promise<NodeActionResult> {
  if (conn.ws?.readyState !== 1) return { ok: false, error: 'offline' };
  try {
    const frame = await sealFrame(conn.contentKey, command);
    if (frame.byteLength > 1_000_000) {
      return { ok: false, error: 'frame over relay limit' };
    }
    conn.ws.send(new Uint8Array(frame).slice().buffer as ArrayBuffer);
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/** 已过 parseGuestOutbound 校验的命令发给指定节点 */
export function sendToNode(nodeId: string, command: PhoneToHost): Promise<NodeActionResult> {
  const conn = connections.get(nodeId);
  if (!conn) return Promise.resolve({ ok: false, error: 'node not found' });
  return sendFrame(conn, command);
}
