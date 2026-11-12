import type { BotChat, Delegation } from '@shared/types/bot';
import { describe, expect, it, vi } from 'vitest';
import { projectIdForBotConversation } from './botFileLink';

vi.mock('@/stores/bots', () => ({ useBotsStore: () => undefined }));
vi.mock('@/components/chat/Markdown', () => ({ MarkdownLinkContext: null }));

const chat = (patch: Partial<BotChat>): BotChat =>
  ({
    id: 'chat',
    kind: 'direct',
    workspace: { kind: 'member-home' },
    sessions: {},
    ...patch,
  }) as BotChat;

describe('projectIdForBotConversation', () => {
  it('member-home 用列表补上的项目 id，绑项目的聊天用工作区项目', () => {
    const home = chat({
      sessions: { bot: { conversationId: 'c-home', cursor: 0, projectId: 'home-project' } },
    });
    const project = chat({
      id: 'group',
      workspace: { kind: 'project', projectId: 'code-project' },
      sessions: { bot: { conversationId: 'c-code', cursor: 0 } },
    });
    expect(projectIdForBotConversation([home, project], [], 'c-home')).toBe('home-project');
    expect(projectIdForBotConversation([home, project], [], 'c-code')).toBe('code-project');
    expect(projectIdForBotConversation([home], [], 'missing')).toBeUndefined();
  });

  it('委派子会话沿用父聊天的项目', () => {
    const home = chat({
      id: 'direct',
      sessions: { bot: { conversationId: 'parent', cursor: 0, projectId: 'home-project' } },
    });
    const delegation = { childConversationId: 'child', chatId: 'direct' } as Delegation;
    expect(projectIdForBotConversation([home], [delegation], 'child')).toBe('home-project');
  });
});
