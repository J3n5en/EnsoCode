import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { PairedDevice } from '@enso/pair';
import { app, safeStorage } from 'electron';

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

function storePath(): string {
  return path.join(app.getPath('userData'), 'remote-nodes.bin');
}

function isSecureStorageAvailable(): boolean {
  try {
    return safeStorage.isEncryptionAvailable();
  } catch {
    return false;
  }
}

// ── 纯函数 ────────────────────────────────────────────────────────────

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
  return [
    ...list,
    { ...device, nodeId: device.pairId, label: trimmed || defaultLabel(list) },
  ];
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

let cache: RemoteNode[] | null = null;

export function loadNodes(): RemoteNode[] {
  if (cache) return cache;
  try {
    const file = storePath();
    if (!existsSync(file)) {
      cache = [];
      return cache;
    }
    const raw = readFileSync(file);
    const json = isSecureStorageAvailable()
      ? safeStorage.decryptString(raw)
      : raw.toString('utf-8');
    const parsed = JSON.parse(json);
    cache = Array.isArray(parsed) ? (parsed as RemoteNode[]) : [];
  } catch {
    cache = [];
  }
  return cache;
}

/** 原子写：临时文件 + rename，避免崩溃损坏 */
export function saveNodes(nodes: RemoteNode[]): void {
  cache = nodes;
  try {
    const file = storePath();
    const json = JSON.stringify(nodes);
    const data = isSecureStorageAvailable()
      ? safeStorage.encryptString(json)
      : Buffer.from(json, 'utf-8');
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, data);
    renameSync(tmp, file);
  } catch (error) {
    console.warn('[nodes] save failed', error);
  }
}
