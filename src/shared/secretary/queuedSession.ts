/**
 * 排队会话：秘书派活超过同时派发上限时，会话照常建出来（行、worktree、分支都在），
 * 但首条消息先存在行上的 queuedStart 里，不 spawn、不 prompt。
 * 有空位时 Main 按 queuedAt 先进先出启动；启动成功后整个字段删掉，goal 这时才写进行。
 */
export interface QueuedStart {
  /** 排队时间：先进先出的排序键 */
  queuedAt: number;
  /** 首条消息原文，不含 goal kickoff */
  text: string;
  /** 启动时才写进行的目标 */
  goal?: string;
  /** 已校验过的图片真实路径，启动时再读 */
  attachments?: string[];
  /** 启动时随 spawn 带给 worker */
  askRelay?: { name: string };
  /** 正在启动：落盘的认领标记，防同一条被启动两次；重启时据此恢复 */
  startingAt?: number;
  /** 自动启动失败：移出自动队列，等用户「立即开始」重试或取消 */
  failed?: { at: number; error: string };
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const finite = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);

export function queuedStartOf(row: unknown): QueuedStart | undefined {
  if (!isRecord(row) || !isRecord(row.queuedStart)) return undefined;
  const raw = row.queuedStart;
  if (!finite(raw.queuedAt) || typeof raw.text !== 'string') return undefined;
  const attachments = Array.isArray(raw.attachments)
    ? raw.attachments.filter((item): item is string => typeof item === 'string')
    : [];
  const askRelay =
    isRecord(raw.askRelay) && typeof raw.askRelay.name === 'string'
      ? { name: raw.askRelay.name }
      : undefined;
  const failed =
    isRecord(raw.failed) && finite(raw.failed.at) && typeof raw.failed.error === 'string'
      ? { at: raw.failed.at, error: raw.failed.error }
      : undefined;
  return {
    queuedAt: raw.queuedAt,
    text: raw.text,
    ...(typeof raw.goal === 'string' && raw.goal ? { goal: raw.goal } : {}),
    ...(attachments.length > 0 ? { attachments } : {}),
    ...(askRelay ? { askRelay } : {}),
    ...(finite(raw.startingAt) ? { startingAt: raw.startingAt } : {}),
    ...(failed ? { failed } : {}),
  };
}

/** 排队归属：同一个秘书的上限只管它自己派出的会话 */
export function queueOwnerOf(row: unknown): string {
  const origin = isRecord(row) && isRecord(row.secretaryOrigin) ? row.secretaryOrigin : undefined;
  return typeof origin?.secretaryId === 'string' ? origin.secretaryId : '';
}

/**
 * 每个秘书各自的排队顺序（从 1 开始）。启动失败的不占位；
 * Main 的启动顺序、侧栏「第 N 位」、看板与手机端都读这一处。
 */
export function queuePositions(rows: Readonly<Record<string, unknown>>): Map<string, number> {
  const groups = new Map<string, { id: string; at: number }[]>();
  for (const [id, row] of Object.entries(rows)) {
    const queued = queuedStartOf(row);
    if (!queued || queued.failed) continue;
    const owner = queueOwnerOf(row);
    const group = groups.get(owner) ?? [];
    group.push({ id, at: queued.queuedAt });
    groups.set(owner, group);
  }
  const positions = new Map<string, number>();
  for (const group of groups.values()) {
    group.sort((left, right) => left.at - right.at || left.id.localeCompare(right.id));
    group.forEach((entry, index) => positions.set(entry.id, index + 1));
  }
  return positions;
}
