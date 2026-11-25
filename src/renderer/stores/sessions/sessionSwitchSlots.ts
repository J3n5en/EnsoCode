import { pinnedConversationIds, projectConversationIds } from './pinned';

/** 每个项目默认露出的会话数,超过折叠进「展开」 */
export const COLLAPSED_SESSION_LIMIT = 5;
/** 每次「展开其余」再露出的条数 */
export const SESSION_EXPAND_STEP = 15;
export const SESSION_SWITCH_SLOT_LIMIT = 9;

/** 项目列表当前应露出的条数 */
export function shownConversationCount(total: number, revealedExtra: number): number {
  if (total <= 0) return 0;
  return Math.min(total, COLLAPSED_SESSION_LIMIT + Math.max(0, revealedExtra));
}

/**
 * 下一次点击后的 extra：已全部露出则收起为 0，否则 +15 并在「能露出的最大 extra」处封顶。
 */
export function nextRevealedExtra(total: number, revealedExtra: number): number {
  const shown = shownConversationCount(total, revealedExtra);
  if (shown >= total) return 0;
  return Math.min(
    Math.max(0, total - COLLAPSED_SESSION_LIMIT),
    revealedExtra + SESSION_EXPAND_STEP
  );
}

/** 收起是展开的逆操作：每次回收 15 条，到折叠上限为止（不是一步跳回 5 条） */
export function prevRevealedExtra(revealedExtra: number): number {
  return Math.max(0, revealedExtra - SESSION_EXPAND_STEP);
}

interface SlotConversation {
  projectId: string;
  pinned?: boolean;
  archived?: boolean;
  createdAt: number;
  lastActiveAt?: number;
  messages: { timestamp?: number }[];
}

type Conversations = Record<string, SlotConversation | undefined>;

export function sessionSwitchSlotIds(input: {
  order: readonly string[];
  conversations: Conversations;
  pinnedOrderIds?: readonly string[];
  /** 未归档项目 id（归档项目不进槽位） */
  projectIds: readonly string[];
  archivedProjectIds?: readonly string[];
  collapsedProjects?: Record<string, boolean>;
  /** 该项目已额外露出的条数；缺省 0 = 只露折叠上限 */
  revealedExtras?: Record<string, number>;
  /** 侧栏「活跃中」可见行，占 Cmd+1… 最前槽 */
  leadingIds?: readonly string[];
}): string[] {
  const {
    order,
    conversations,
    pinnedOrderIds = [],
    projectIds,
    archivedProjectIds = [],
    collapsedProjects = {},
    revealedExtras = {},
    leadingIds = [],
  } = input;

  const slots: string[] = [];
  const seen = new Set<string>();
  const push = (id: string) => {
    if (seen.has(id) || slots.length >= SESSION_SWITCH_SLOT_LIMIT) return;
    seen.add(id);
    slots.push(id);
  };

  for (const id of leadingIds) push(id);

  const pinned = pinnedConversationIds(order, conversations, pinnedOrderIds, archivedProjectIds);
  for (const id of pinned) push(id);

  for (const projectId of projectIds) {
    if (slots.length >= SESSION_SWITCH_SLOT_LIMIT) break;
    const folded = collapsedProjects[projectId] === true;
    if (folded) continue;
    const projectConversations = projectConversationIds(order, conversations, projectId);
    const shown = projectConversations.slice(
      0,
      shownConversationCount(projectConversations.length, revealedExtras[projectId] ?? 0)
    );
    for (const id of shown) push(id);
  }

  return slots;
}
