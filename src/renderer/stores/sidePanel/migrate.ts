import { normalizeGlobalState } from './globalTabs';

/**
 * v4：snapshotsByConversation 不再 persist（几 MB 文件文本拖慢每次 set），改由主进程按会话落盘。
 * v5：只加 globalTabs / globalScopeOverrides，其余字段原样保留。
 */
export const SIDE_PANEL_VERSION = 5;
const SNAPSHOTS_ON_DISK_VERSION = 4;

type Snapshots = Record<string, Record<string, string>>;

const isPlainObject = (value: unknown): value is Record<string, unknown> => {
  if (!value || typeof value !== 'object') return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
};

function pickSnapshots(raw: unknown): Snapshots {
  if (!isPlainObject(raw)) return {};
  const out: Snapshots = {};
  for (const [id, files] of Object.entries(raw)) {
    if (!isPlainObject(files)) continue;
    const kept: Record<string, string> = {};
    for (const [path, text] of Object.entries(files)) {
      if (typeof text === 'string') kept[path] = text;
    }
    if (Object.keys(kept).length > 0) out[id] = kept;
  }
  return out;
}

/** 旧版 persist 里把快照剥出来：返回不含快照的 state + 需要落盘的快照 */
export function splitLegacySnapshots(
  persisted: unknown,
  version: number
): { state: Record<string, unknown>; snapshots: Snapshots } {
  const old: Record<string, unknown> = isPlainObject(persisted) ? persisted : {};
  if (version < 2) return { state: { uiByConversation: {}, layouts: {} }, snapshots: {} };
  if (version < SNAPSHOTS_ON_DISK_VERSION) {
    return {
      state: {
        uiByConversation: version < 3 ? {} : (old.uiByConversation ?? {}),
        layouts: old.layouts ?? {},
        changesModeByConversation: old.changesModeByConversation ?? {},
      },
      snapshots: pickSnapshots(old.snapshotsByConversation),
    };
  }
  const { snapshotsByConversation: _dropped, ...state } = old;
  return { state, snapshots: {} };
}

export function migrateSidePanelState(
  persisted: unknown,
  version: number
): { state: Record<string, unknown>; snapshots: Snapshots } {
  const { state, snapshots } = splitLegacySnapshots(persisted, version);
  return { state: { ...state, ...normalizeGlobalState(state) }, snapshots };
}
