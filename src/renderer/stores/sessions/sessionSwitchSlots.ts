import { pinnedConversationIds, projectConversationIds } from './pinned';

/** 每个项目默认露出的会话数,超过折叠进「展开」 */
export const COLLAPSED_SESSION_LIMIT = 5;
export const SESSION_SWITCH_SLOT_LIMIT = 9;

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
  projectIds: readonly string[];
  collapsedProjects?: Record<string, boolean>;
  expandedProjects?: Record<string, boolean>;
  searching?: boolean;
  matches?: (id: string) => boolean;
  projectMatches?: (projectId: string) => boolean;
}): string[] {
  const {
    order,
    conversations,
    pinnedOrderIds = [],
    projectIds,
    collapsedProjects = {},
    expandedProjects = {},
    searching = false,
    matches = () => true,
    projectMatches = () => false,
  } = input;

  const slots: string[] = [];
  const seen = new Set<string>();
  const push = (id: string) => {
    if (seen.has(id) || slots.length >= SESSION_SWITCH_SLOT_LIMIT) return;
    seen.add(id);
    slots.push(id);
  };

  const pinned = pinnedConversationIds(order, conversations, pinnedOrderIds);
  for (const id of searching ? pinned.filter(matches) : pinned) push(id);

  for (const projectId of projectIds) {
    if (slots.length >= SESSION_SWITCH_SLOT_LIMIT) break;
    const folded = searching ? false : collapsedProjects[projectId] === true;
    if (folded) continue;
    const projectConversations = projectConversationIds(order, conversations, projectId);
    const visible =
      !searching || projectMatches(projectId)
        ? projectConversations
        : projectConversations.filter(matches);
    const shown =
      searching || expandedProjects[projectId]
        ? visible
        : visible.slice(0, COLLAPSED_SESSION_LIMIT);
    for (const id of shown) push(id);
  }

  return slots;
}
