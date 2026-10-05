import { randomUUID } from 'node:crypto';
import {
  assignTeamNames,
  type TeamMemberAssets,
  type TeamSpec,
  teamMemberDrafts,
} from '../../../shared/bots/team';
import type { BotChat, BotChatWorkspace, BotProfile } from '../../../shared/types/bot';
import type { BotStore } from './botStore';
import type { BotChatStore } from './chatStore';

export interface TeamCreateOptions {
  reserved: readonly string[];
  resolveWorkspace: (chatId: string) => BotChatWorkspace | { error: string };
  /** 回滚：撤销 resolveWorkspace 新建的工作区 */
  releaseWorkspace: (chatId: string, workspace: BotChatWorkspace) => void;
  assets?: TeamMemberAssets;
}

export type TeamCreateResult =
  | { ok: true; chat: BotChat; bots: BotProfile[] }
  | { ok: false; error: string };

/** 原子创建团队：任一步失败删除已建成员并释放工作区 */
export function createTeam(
  stores: {
    bots: Pick<BotStore, 'list' | 'create' | 'remove'>;
    chats: Pick<BotChatStore, 'create'>;
  },
  spec: TeamSpec,
  options: TeamCreateOptions
): TeamCreateResult {
  const { team } = assignTeamNames(spec, stores.bots.list(), options.reserved);
  const ids = Object.fromEntries(team.members.map((member) => [member.key, randomUUID()]));
  const created: BotProfile[] = [];
  const chatId = randomUUID();
  let workspace: BotChatWorkspace | undefined;
  const rollback = (error: string): TeamCreateResult => {
    if (workspace) {
      try {
        options.releaseWorkspace(chatId, workspace);
      } catch {
        // 尽力清理
      }
    }
    for (const bot of created) stores.bots.remove(bot.id);
    return { ok: false, error };
  };
  try {
    for (const { id, draft } of teamMemberDrafts(team, ids, options.assets)) {
      const result = stores.bots.create(draft, options.reserved, id);
      if (!result.ok) return rollback(result.reason);
      created.push(result.bot);
    }
    const resolved = options.resolveWorkspace(chatId);
    if ('error' in resolved) return rollback(resolved.error);
    workspace = resolved;
    const chat = stores.chats.create(
      {
        kind: 'group',
        title: team.title,
        members: created.map((bot) => bot.id),
        bossBotId: ids[team.bossKey],
        workspace,
        routing: team.routing,
      },
      chatId
    );
    return chat ? { ok: true, chat, bots: created } : rollback('invalid');
  } catch (error) {
    return rollback(error instanceof Error ? error.message : 'unavailable');
  }
}
