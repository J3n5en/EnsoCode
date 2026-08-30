import type { PairedDevice } from '@enso/pair';

/**
 * 多桌面配对的设备列表（纯函数）。
 * 协议里桌面从不下发自己的主机名（PairedDevice.deviceName 是手机自己的名字），
 * 列表标签只能手机侧起：默认「电脑 N」，可重命名。
 */

export interface StoredDevice extends PairedDevice {
  /** 手机侧给这台桌面起的名字 */
  label: string;
}

/** 读列表键 + 旧单配对键迁移：列表键优先；坏 JSON 一律降级为空 */
export function migrateStore(listRaw: string | null, legacyRaw: string | null): StoredDevice[] {
  if (listRaw) {
    try {
      const parsed = JSON.parse(listRaw) as StoredDevice[];
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  if (legacyRaw) {
    try {
      const device = JSON.parse(legacyRaw) as PairedDevice;
      return device?.pairId ? [{ ...device, label: defaultLabel([]) }] : [];
    } catch {
      return [];
    }
  }
  return [];
}

/** 最小可用的「电脑 N」：默认名有洞时填洞，不与自定义名相撞 */
function defaultLabel(list: readonly StoredDevice[]): string {
  const used = new Set(list.map((d) => d.label));
  for (let n = 1; ; n++) {
    const label = `电脑 ${n}`;
    if (!used.has(label)) return label;
  }
}

/** 新增或按 pairId 更新凭据；更新时保留自定义名与列表位置 */
export function upsertDevice(list: readonly StoredDevice[], device: PairedDevice): StoredDevice[] {
  const existing = list.find((d) => d.pairId === device.pairId);
  if (existing) {
    return list.map((d) => (d.pairId === device.pairId ? { ...device, label: d.label } : d));
  }
  return [...list, { ...device, label: defaultLabel(list) }];
}

export function removeDevice(list: readonly StoredDevice[], pairId: string): StoredDevice[] {
  return list.filter((d) => d.pairId !== pairId);
}

export function renameDevice(
  list: readonly StoredDevice[],
  pairId: string,
  label: string
): StoredDevice[] {
  const trimmed = label.trim();
  if (!trimmed) return [...list];
  return list.map((d) => (d.pairId === pairId ? { ...d, label: trimmed } : d));
}

/** 解析活跃设备：命中返回该台；失配（已被删）回落第一台；空列表 null */
export function pickActive(
  list: readonly StoredDevice[],
  activeId: string | null
): StoredDevice | null {
  return list.find((d) => d.pairId === activeId) ?? list[0] ?? null;
}
