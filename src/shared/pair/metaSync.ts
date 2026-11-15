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

/** providers 通道只按 id 去重；名称/标签/数组顺序变化不重打 14kB 模型表。 */
export function providersSyncFingerprint(
  list: readonly { id: string; models?: readonly { id: string }[] }[]
): string {
  return pairJsonFingerprint(
    [...list]
      .map((p) => ({
        id: p.id,
        models: [...(p.models ?? [])].map((m) => m.id).sort(),
      }))
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  );
}

export type ProviderEmitPlan =
  | { kind: 'unchanged' }
  | { kind: 'defer'; delayMs: number }
  | { kind: 'send' };

/**
 * 进房连打 / oauth 短抖动：同一连接 1.5s 内 providers 只出一帧。
 * 指纹变了但落在窗口里时必须延后补发。
 * 当成已发出会把空列表锁死，手机就一直显示没有模型服务。
 */
export function planProviderEmit(
  lastFp: string | undefined,
  lastAt: number | undefined,
  nextFp: string,
  now: number,
  windowMs = 1500
): ProviderEmitPlan {
  if (lastFp === nextFp) return { kind: 'unchanged' };
  if (lastAt !== undefined && now - lastAt < windowMs) {
    return { kind: 'defer', delayMs: Math.max(0, windowMs - (now - lastAt)) };
  }
  return { kind: 'send' };
}

export function shouldEmitProviders(
  lastFp: string | undefined,
  lastAt: number | undefined,
  nextFp: string,
  now: number,
  windowMs = 1500
): boolean {
  return planProviderEmit(lastFp, lastAt, nextFp, now, windowMs).kind === 'send';
}

/** defer 的 providers 不能进本次发送集合，否则 stable 会提前锁上还没发出的指纹。 */
export function providerChannelsToSend(
  allowed: readonly PairMetaChannel[],
  plan: ProviderEmitPlan
): { channels: PairMetaChannel[]; deferMs?: number } {
  if (plan.kind !== 'defer') return { channels: [...allowed] };
  return {
    channels: allowed.filter((key) => key !== 'providers'),
    deferMs: plan.delayMs,
  };
}

/** 完整模式只用 host-info 与推送配置；目录/项目/模型表/外观走 renderer 隧道 */
const DESK_META_CHANNELS = new Set<PairMetaChannel>(['pushConfig', 'hostInfo']);

export function guestMetaChannels(
  channels: readonly PairMetaChannel[],
  desk: boolean
): PairMetaChannel[] {
  return desk ? channels.filter((key) => DESK_META_CHANNELS.has(key)) : [...channels];
}

/** 列表会话剥掉聊天专用字段；当前订阅保留 cwd/排队/模型 */
const CATALOG_CHAT_KEYS = [
  'cwd',
  'queued',
  'goal',
  'slashCommands',
  'context',
  'usageTotals',
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
 * 进房作废全部指纹。PWA 刷新后内存是空的，模型表/项目/推送都不能按上次指纹跳过。
 * 同一连接连打仍靠 shouldEmitProviders / rememberStableMeta 去重。
 */
export function forgetGuestSyncMeta(
  _last: PairMetaFingerprints | undefined
): PairMetaFingerprints | undefined {
  return undefined;
}

/** pair 进程内低频通道指纹，避免进房时 conn.sentMeta 被清掉后重打 providers。 */
export function mergeStableMeta(
  stable: PairMetaFingerprints | undefined,
  sent: PairMetaFingerprints | undefined
): PairMetaFingerprints | undefined {
  if (!stable && !sent) return undefined;
  const merged = { ...stable, ...sent };
  return Object.keys(merged).length > 0 ? merged : undefined;
}

/** 低频通道在 await send 之前入账，避免 peer-joined / 直连 resync 并行各打一遍 providers。 */
export function rememberStableMeta(
  stored: PairMetaFingerprints | undefined,
  allowed: Iterable<PairMetaChannel>,
  next: PairMetaFingerprints
): PairMetaFingerprints | undefined {
  const extra: PairMetaFingerprints = {};
  for (const key of allowed) {
    if (key !== 'providers') continue;
    const fp = next[key];
    if (fp !== undefined) extra[key] = fp;
  }
  return mergeStableMeta(stored, extra);
}

/**
 * last 与 next 指纹不同的通道才发。force 忽略 last，整包重发。
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
