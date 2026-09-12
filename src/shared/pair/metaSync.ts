/**
 * 手机目录/外观下行去重：流式 upsert 会 300ms 推一次同样的 6 帧 meta，
 * 按通道指纹跳过未变内容。catalog 的 updatedAt 随末条消息跳，不进指纹。
 */

export const PAIR_META_CHANNELS = [
  'catalog',
  'projects',
  'providers',
  'appearance',
  'pushConfig',
  'hostInfo',
] as const;

export type PairMetaChannel = (typeof PAIR_META_CHANNELS)[number];
export type PairMetaFingerprints = Partial<Record<PairMetaChannel, string>>;

export function catalogSyncFingerprint(
  entries: readonly object[],
  pinnedOrder: readonly string[] = []
): string {
  return JSON.stringify({
    pinnedOrder,
    entries: entries.map((entry) => {
      const { updatedAt: _updatedAt, ...rest } = entry as {
        updatedAt?: unknown;
      } & Record<string, unknown>;
      return rest;
    }),
  });
}

export function pairJsonFingerprint(value: unknown): string {
  return JSON.stringify(value);
}

/** 列表会话剥掉聊天专用字段；当前订阅保留 cwd/排队/模型 */
const CATALOG_CHAT_KEYS = [
  'cwd',
  'queued',
  'goal',
  'projectName',
  'providerId',
  'modelId',
  'reasoningEnabled',
  'thinkingLevel',
] as const;

export function slimCatalogForPhone<T extends { id: string }>(
  entries: readonly T[],
  subscribedId: string | null
): T[] {
  return entries.map((entry) => {
    if (entry.id === subscribedId) return entry;
    const next = { ...entry } as T & Record<string, unknown>;
    for (const key of CATALOG_CHAT_KEYS) delete next[key];
    return next;
  });
}

/** 项目帧不下发本机 path：手机 spawn 只传 projectId，cwd 由 main 反查 */
export function slimProjectsForPhone<T extends object>(projects: readonly T[]): T[] {
  return projects.map((project) => {
    const next = { ...project } as T & { path?: unknown };
    delete next.path;
    return next;
  });
}

export function changedMetaChannels(
  last: PairMetaFingerprints | undefined,
  next: PairMetaFingerprints
): PairMetaChannel[] {
  return PAIR_META_CHANNELS.filter((key) => {
    const fp = next[key];
    return fp !== undefined && last?.[key] !== fp;
  });
}

/** 内容来自 renderer 的通道：main 在首次 PAIR_CATALOG 前只持有空初值，不构成真目录 */
const RENDERER_OWNED_CHANNELS: ReadonlySet<PairMetaChannel> = new Set([
  'catalog',
  'projects',
  'providers',
  'appearance',
]);

/**
 * renderer 尚未推过目录时扣下 renderer-owned 通道。
 * host 重启后 guest 往往已在房里，peer-joined 会先于 renderer 首次 push 到达；
 * 若此时把空 catalog 当真目录发出，guest 会把仍在订阅的会话误判为幽灵而跳回列表页。
 */
export function withholdRendererMeta(
  channels: readonly PairMetaChannel[],
  catalogReady: boolean
): PairMetaChannel[] {
  if (catalogReady) return [...channels];
  return channels.filter((key) => !RENDERER_OWNED_CHANNELS.has(key));
}

/**
 * guest 显式 snapshot（桌面 renderer 重载 / 手机进房）必须整包重发：
 * 指纹去重只对 host 自发的流式 upsert 有效。连接常驻时 renderer 还没挂上
 * IPC 监听，目录帧会丢；若 snapshot 再被当成「已发过」节点就会一直转圈。
 */
export function channelsForMetaPush(
  last: PairMetaFingerprints | undefined,
  next: PairMetaFingerprints,
  catalogReady: boolean,
  force = false
): PairMetaChannel[] {
  return withholdRendererMeta(changedMetaChannels(force ? undefined : last, next), catalogReady);
}

/** 只转发手机 subscribe/history 点名的 snapshot，桌面自己的刷新不转 */
export function shouldRelayPairSnapshot(conn: {
  subscribedId: string | null;
  pendingSnapshot?: boolean;
  pendingHistory?: number;
}): boolean {
  if (!conn.subscribedId) return false;
  return conn.pendingSnapshot === true || conn.pendingHistory !== undefined;
}
