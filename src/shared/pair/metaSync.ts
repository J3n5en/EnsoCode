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
