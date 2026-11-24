/**
 * 多个主界面 renderer（桌面窗口 + 远程浏览器）并存时，`enso-conversations` 持久化按字段级补丁合并，
 * 避免整份覆盖互相吞掉对方的会话。形状对应 zustand persist 的 StorageValue<SessionsPersistSlice>。
 */

export interface ConversationRowPatch {
  set: Record<string, unknown>;
  unset: string[];
}

export interface ConversationsPatch {
  upserts: Record<string, ConversationRowPatch>;
  removes: string[];
  order?: string[];
}

/** Main 推送的补丁带单调序号；renderer 写回时把它作为确认号，Main 据此只回放未确认的部分 */
export interface SequencedConversationsPatch extends ConversationsPatch {
  seq: number;
}

type Row = Record<string, unknown>;
interface Slice {
  conversations: Record<string, Row>;
  order: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function sliceOf(value: unknown): Slice {
  const state = isRecord(value) && isRecord(value.state) ? value.state : {};
  const conversations = isRecord(state.conversations)
    ? (state.conversations as Record<string, Row>)
    : {};
  const order = Array.isArray(state.order)
    ? state.order.filter((id): id is string => typeof id === 'string')
    : [];
  return { conversations, order };
}

const same = (a: unknown, b: unknown): boolean =>
  a === b || JSON.stringify(a) === JSON.stringify(b);

/** 落盘与远端编码都是 JSON 语义：值为 undefined 的字段等同缺省（renderer 经结构化克隆写回会带着它们） */
const field = (row: Row, key: string): unknown => (Object.hasOwn(row, key) ? row[key] : undefined);

/** 侧栏 order 只收根会话；子会话 / btw 只挂在父会话下 */
const isOrderRoot = (row: unknown): boolean => isRecord(row) && !row.parentId && !row.btwParentId;

export function isEmptyConversationsPatch(patch: ConversationsPatch): boolean {
  return Object.keys(patch.upserts).length === 0 && patch.removes.length === 0 && !patch.order;
}

/** persist blob 的 conversations 与 order 同时为空（含缺 key / 非对象） */
export function isEmptyConversationsStore(value: unknown): boolean {
  const { conversations, order } = sliceOf(value);
  return Object.keys(conversations).length === 0 && order.length === 0;
}

/** persist blob 形状完整：state.conversations 是对象、state.order 是数组 */
export function isConversationsStore(value: unknown): boolean {
  return (
    isRecord(value) &&
    isRecord(value.state) &&
    isRecord(value.state.conversations) &&
    Array.isArray(value.state.order)
  );
}

/** 补丁会删掉 target 上现有的全部会话（target 本身为空不算） */
export function removesAllConversations(target: unknown, patch: ConversationsPatch): boolean {
  const ids = Object.keys(sliceOf(target).conversations);
  const removes = new Set(patch.removes);
  return ids.length > 0 && ids.every((id) => removes.has(id));
}

export function diffConversations(previous: unknown, next: unknown): ConversationsPatch {
  const before = sliceOf(previous);
  const after = sliceOf(next);
  const upserts: Record<string, ConversationRowPatch> = {};
  for (const [id, row] of Object.entries(after.conversations)) {
    if (!isRecord(row)) continue;
    const old = before.conversations[id];
    const base = isRecord(old) ? old : {};
    const set: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(row)) {
      if (value === undefined) continue;
      const prev = field(base, key);
      if (prev === undefined || !same(prev, value)) set[key] = value;
    }
    const unset = Object.keys(base).filter(
      (key) => base[key] !== undefined && field(row, key) === undefined
    );
    if (!isRecord(old) || Object.keys(set).length > 0 || unset.length > 0) {
      upserts[id] = { set, unset };
    }
  }
  const removes = Object.keys(before.conversations).filter((id) => !(id in after.conversations));
  const orderChanged =
    before.order.length !== after.order.length ||
    before.order.some((id, index) => after.order[index] !== id);
  return { upserts, removes, ...(orderChanged ? { order: after.order } : {}) };
}

/** 补丁顺序为准；目标里补丁不认识的会话（对方并发新建）保持原相对次序放在最前 */
export function mergeConversationOrder(
  target: string[],
  patchOrder: string[],
  exists: (id: string) => boolean
): string[] {
  const inPatch = new Set(patchOrder);
  const extras = target.filter((id) => !inPatch.has(id) && exists(id));
  const seen = new Set<string>();
  return [...extras, ...patchOrder.filter((id) => exists(id))].filter((id) => {
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

export function applyConversationsPatch(target: unknown, patch: ConversationsPatch): unknown {
  const root = isRecord(target) ? target : {};
  const state = isRecord(root.state) ? root.state : {};
  const { conversations, order } = sliceOf(target);
  const nextConversations: Record<string, Row> = { ...conversations };
  for (const id of patch.removes) delete nextConversations[id];
  for (const [id, row] of Object.entries(patch.upserts)) {
    const current = nextConversations[id];
    // 目标里已没有的会话只收到字段级差量时拼不出完整行，丢弃
    if (!isRecord(current) && typeof row.set.id !== 'string') continue;
    const merged: Row = { ...(isRecord(current) ? current : {}) };
    for (const key of row.unset) delete merged[key];
    Object.assign(merged, row.set);
    nextConversations[id] = merged;
  }
  const exists = (id: string) => isOrderRoot(nextConversations[id]);
  const baseOrder = patch.order
    ? mergeConversationOrder(order, patch.order, exists)
    : order.filter(exists);
  const listed = new Set(baseOrder);
  const added = Object.keys(patch.upserts).filter((id) => exists(id) && !listed.has(id));
  return {
    ...root,
    state: { ...state, conversations: nextConversations, order: [...added, ...baseOrder] },
  };
}

export function parseConversationsPatch(value: unknown): SequencedConversationsPatch | null {
  if (!isRecord(value) || !isRecord(value.upserts) || !Array.isArray(value.removes)) return null;
  const upserts: Record<string, ConversationRowPatch> = {};
  for (const [id, row] of Object.entries(value.upserts)) {
    if (!isRecord(row) || !isRecord(row.set) || !Array.isArray(row.unset)) return null;
    upserts[id] = {
      set: row.set,
      unset: row.unset.filter((key): key is string => typeof key === 'string'),
    };
  }
  const removes = value.removes.filter((id): id is string => typeof id === 'string');
  const order = Array.isArray(value.order)
    ? value.order.filter((id): id is string => typeof id === 'string')
    : undefined;
  const seq =
    typeof value.seq === 'number' && Number.isInteger(value.seq) && value.seq >= 0 ? value.seq : 0;
  return { upserts, removes, ...(order ? { order } : {}), seq };
}
