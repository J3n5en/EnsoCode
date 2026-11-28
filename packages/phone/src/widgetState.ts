import type { CatalogEntry } from '@enso/pair';
import type { NativeWidgetSessionItem, NativeWidgetSnapshot } from './nativeBridge';

/** 前端推送到 iOS 小组件 / 灵动岛的状态快照聚合器（纯函数，便于单测） */
export interface PhoneWidgetInput {
  deviceLabel: string;
  connectionState: string;
  transport: string;
  rttMs: number | null;
  catalog: CatalogEntry[];
  activeId: string | null;
  activeDetail?: string | null;
  now?: number;
}

function pendingOf(entry: CatalogEntry): number {
  return (entry.pendingApprovalCount ?? 0) + (entry.pendingAskCount ?? 0);
}

function rankEntry(entry: CatalogEntry): number {
  if (pendingOf(entry) > 0) return 3;
  if (entry.status === 'running') return 2;
  if (entry.unread) return 1;
  return 0;
}

export function buildWidgetSnapshotFromCatalog(input: PhoneWidgetInput): NativeWidgetSnapshot {
  const now = input.now ?? Date.now();
  const visible = input.catalog.filter((c) => !c.archived && !c.parentId);

  let runningCount = 0;
  let pendingCount = 0;
  let unreadCount = 0;
  for (const entry of visible) {
    if (entry.status === 'running') runningCount += 1;
    pendingCount += pendingOf(entry);
    if (entry.unread) unreadCount += 1;
  }

  const sorted = [...visible].sort((a, b) => {
    const diff = rankEntry(b) - rankEntry(a);
    if (diff !== 0) return diff;
    return (b.updatedAt ?? 0) - (a.updatedAt ?? 0);
  });

  const focus =
    sorted.find((c) => pendingOf(c) > 0) ??
    sorted.find((c) => c.status === 'running') ??
    visible.find((c) => c.id === input.activeId) ??
    sorted[0] ??
    null;

  const sessions: NativeWidgetSessionItem[] = sorted.slice(0, 6).map((c) => ({
    id: c.id,
    title: c.title || '未命名会话',
    projectName: c.projectName || input.deviceLabel,
    status: pendingOf(c) > 0 ? 'waiting' : c.status,
    pendingCount: pendingOf(c),
    unread: Boolean(c.unread),
    updatedAt: c.updatedAt ?? now,
  }));

  const activeStatus =
    pendingCount > 0
      ? 'pending'
      : runningCount > 0
        ? 'running'
        : input.connectionState === 'online'
          ? 'idle'
          : 'offline';

  const activeDetail =
    input.activeDetail ??
    (pendingCount > 0
      ? `有 ${pendingCount} 项待确认`
      : runningCount > 0
        ? runningCount > 1
          ? `${runningCount} 个会话运行中`
          : 'Agent 执行中'
        : input.connectionState === 'online'
          ? '已连接，暂无运行中任务'
          : '等待重连桌面端');

  return {
    deviceLabel: input.deviceLabel || 'EnsoCode',
    connectionState: input.connectionState,
    transport: input.transport,
    rttMs: input.rttMs,
    runningCount,
    pendingCount,
    unreadCount,
    activeTitle: focus?.title ?? null,
    activeProject: focus?.projectName ?? null,
    activeSessionId: focus?.id ?? null,
    activeStatus,
    activeDetail,
    startedAt: runningCount > 0 ? (focus?.updatedAt ?? now) : null,
    sessions,
    updatedAt: now,
  };
}

interface DeskConversationLike {
  id?: unknown;
  title?: unknown;
  projectName?: unknown;
  projectId?: unknown;
  status?: unknown;
  unread?: unknown;
  archived?: unknown;
  parentId?: unknown;
  pendingApprovalCount?: unknown;
  pendingAskCount?: unknown;
  updatedAt?: unknown;
}

/** 完整版（Desk 模式）下从已缓存的 `conversations:read` 载荷提取小组件快照 */
export function buildWidgetSnapshotFromDeskReads(params: {
  deviceLabel: string;
  connectionState: string;
  transport: string;
  rttMs: number | null;
  conversationsJson?: string;
  now?: number;
}): NativeWidgetSnapshot {
  let catalog: CatalogEntry[] = [];
  if (params.conversationsJson) {
    try {
      const parsed = JSON.parse(params.conversationsJson) as
        | DeskConversationLike[]
        | { conversations?: DeskConversationLike[]; items?: DeskConversationLike[] };
      const rawList = Array.isArray(parsed)
        ? parsed
        : Array.isArray(parsed?.conversations)
          ? parsed.conversations
          : Array.isArray(parsed?.items)
            ? parsed.items
            : [];
      catalog = rawList
        .filter(
          (item): item is DeskConversationLike & { id: string } => typeof item?.id === 'string'
        )
        .map((item) => ({
          id: item.id,
          title: typeof item.title === 'string' && item.title ? item.title : '未命名会话',
          projectName:
            typeof item.projectName === 'string' && item.projectName
              ? item.projectName
              : params.deviceLabel,
          projectId: typeof item.projectId === 'string' ? item.projectId : '',
          status: typeof item.status === 'string' ? item.status : 'idle',
          unread: item.unread === true,
          archived: item.archived === true,
          ...(typeof item.parentId === 'string' ? { parentId: item.parentId } : {}),
          pendingApprovalCount:
            typeof item.pendingApprovalCount === 'number' ? item.pendingApprovalCount : 0,
          pendingAskCount: typeof item.pendingAskCount === 'number' ? item.pendingAskCount : 0,
          updatedAt:
            typeof item.updatedAt === 'number' ? item.updatedAt : (params.now ?? Date.now()),
        }));
    } catch {}
  }
  return buildWidgetSnapshotFromCatalog({
    deviceLabel: params.deviceLabel,
    connectionState: params.connectionState,
    transport: params.transport,
    rttMs: params.rttMs,
    catalog,
    activeId: null,
    now: params.now,
  });
}
