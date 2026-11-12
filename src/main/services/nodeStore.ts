import path from 'node:path';
import type { PairedDevice } from '@enso/pair';
import { app } from '@platform';
import { SecureJsonFile } from './secureFile';

/**
 * 「连接到节点」的凭据（本机作为 guest 连别的桌面）。
 * 与 phone-pairing.bin（本机作为 host 收手机/别的桌面）分文件：两者角色相反，
 * 混存会让 host 侧误以 host 身份去连别人的房间。
 * contentKey 是端到端密钥，safeStorage 可用时加密整包；不可用时由 UI 提示。
 */

export interface RemoteNode extends PairedDevice {
  /** = pairId，独立字段是为了 renderer 侧语义清晰 */
  nodeId: string;
  /** 本机给对方起的名字：默认 host-info 的 hostname，可重命名 */
  label: string;
}

// ── 纯函数 ────────────────────────────────────────────────────────────

const DEFAULT_LABEL_RE = /^节点 \d+$/;

/** 最小可用的「节点 N」：默认名有洞时填洞，不与自定义名相撞 */
function defaultLabel(list: readonly RemoteNode[]): string {
  const used = new Set(list.map((n) => n.label));
  for (let n = 1; ; n++) {
    const label = `节点 ${n}`;
    if (!used.has(label)) return label;
  }
}

/** 新增或按 pairId 更新凭据；更新时保留自定义名与列表位置（label 参数只对新节点生效） */
export function upsertNode(
  list: readonly RemoteNode[],
  device: PairedDevice,
  label: string | undefined
): RemoteNode[] {
  const existing = list.find((n) => n.pairId === device.pairId);
  if (existing) {
    return list.map((n) =>
      n.pairId === device.pairId ? { ...device, nodeId: device.pairId, label: n.label } : n
    );
  }
  const trimmed = label?.trim();
  return [...list, { ...device, nodeId: device.pairId, label: trimmed || defaultLabel(list) }];
}

/**
 * 首次收到 host-info：仍是默认「节点 N」的节点改用对方 hostname；用户自定义过的名字不动。
 * 配对时 claim 的应答里没有对方主机名，只能连上后补。
 */
export function adoptHostname(
  list: readonly RemoteNode[],
  nodeId: string,
  hostname: string
): RemoteNode[] {
  const trimmed = hostname.trim();
  if (!trimmed) return [...list];
  return list.map((n) =>
    n.nodeId === nodeId && DEFAULT_LABEL_RE.test(n.label) ? { ...n, label: trimmed } : n
  );
}

export function removeNode(list: readonly RemoteNode[], nodeId: string): RemoteNode[] {
  return list.filter((n) => n.nodeId !== nodeId);
}

export function renameNode(
  list: readonly RemoteNode[],
  nodeId: string,
  label: string
): RemoteNode[] {
  const trimmed = label.trim();
  if (!trimmed) return [...list];
  return list.map((n) => (n.nodeId === nodeId ? { ...n, label: trimmed } : n));
}

// ── 落盘 ──────────────────────────────────────────────────────────────

const nodes = new SecureJsonFile<RemoteNode[]>(
  () => path.join(app.getPath('userData'), 'remote-nodes.bin'),
  () => [],
  (raw) => (Array.isArray(raw) ? (raw as RemoteNode[]) : [])
);

export function nodesReady(): Promise<void> {
  return nodes.ready();
}

export function isNodeStoreSecure(): boolean {
  return nodes.isSecure();
}

export function loadNodes(): RemoteNode[] {
  return nodes.get();
}

export function saveNodes(list: RemoteNode[]): Promise<void> {
  return nodes.set(list);
}
