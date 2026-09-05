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

/** 只转发手机 subscribe/history 点名的 snapshot，桌面自己的刷新不转 */
export function shouldRelayPairSnapshot(conn: {
  subscribedId: string | null;
  pendingSnapshot?: boolean;
  pendingHistory?: number;
}): boolean {
  if (!conn.subscribedId) return false;
  return conn.pendingSnapshot === true || conn.pendingHistory !== undefined;
}
