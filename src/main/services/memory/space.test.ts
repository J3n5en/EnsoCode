import { describe, expect, it } from 'vitest';
import {
  defaultCaptureSpace,
  distillSpaceId,
  distillSpaces,
  memorySpaceContext,
  requestSpaceIds,
  resolveSpaceIds,
  secretaryPrivateSpace,
  secretaryProjectIds,
} from './space';
import {
  botSpaceId,
  chatSpaceId,
  isSpaceId,
  MemoryValidationError,
  parseSpaceId,
  projectSpaceId,
} from './types';

const PROJECT = '11111111-1111-4111-8111-111111111111';
const BOT = '22222222-2222-4222-8222-222222222222';
const CHAT = '33333333-3333-4333-8333-333333333333';
const SECRETARY = '55555555-5555-4555-8555-555555555555';
const VISIBLE = '66666666-6666-4666-8666-666666666666';
const VISIBLE_2 = '77777777-7777-4777-8777-777777777777';
const SESSION = 'secretary-session-1';

describe('space id', () => {
  it('bot:/chat: 构造与解析往返，id 必须是 uuid', () => {
    expect(botSpaceId(BOT)).toBe(`bot:${BOT}`);
    expect(chatSpaceId(CHAT)).toBe(`chat:${CHAT}`);
    expect(parseSpaceId(botSpaceId(BOT))).toEqual({ kind: 'bot', id: BOT });
    expect(parseSpaceId(chatSpaceId(CHAT))).toEqual({ kind: 'chat', id: CHAT });
    expect(parseSpaceId(projectSpaceId(PROJECT))).toEqual({ kind: 'project', id: PROJECT });
    expect(parseSpaceId('global')).toEqual({ kind: 'global' });
    expect(isSpaceId(botSpaceId(BOT))).toBe(true);
    expect(isSpaceId(chatSpaceId(CHAT))).toBe(true);
  });

  it('脏输入：空 id、非 uuid、未知前缀一律拒绝', () => {
    for (const bad of ['bot:', 'chat:', 'bot:abc', 'chat:../x', `team:${BOT}`, '', 'Global']) {
      expect(isSpaceId(bad), bad).toBe(false);
      expect(parseSpaceId(bad), bad).toBeUndefined();
    }
    expect(() => botSpaceId('abc')).toThrow();
    expect(() => chatSpaceId('')).toThrow();
  });
});

describe('resolveSpaceIds', () => {
  it("非 bot 会话：'all' = 项目 + global；无项目时只剩 global", () => {
    expect(resolveSpaceIds('all', { projectId: PROJECT })).toEqual([
      projectSpaceId(PROJECT),
      'global',
    ]);
    expect(resolveSpaceIds('all', { projectId: null })).toEqual(['global']);
    expect(resolveSpaceIds('global', { projectId: PROJECT })).toEqual(['global']);
    expect(resolveSpaceIds('project', { projectId: PROJECT })).toEqual([projectSpaceId(PROJECT)]);
  });

  it("'project' 但会话无项目 → 空集合（search 空结果 / capture 拒绝）", () => {
    expect(resolveSpaceIds('project', {})).toEqual([]);
  });

  it("bot 会话 'all' 顺序：bot → chat → project → global", () => {
    expect(resolveSpaceIds('all', { botId: BOT, chatId: CHAT, projectId: PROJECT })).toEqual([
      botSpaceId(BOT),
      chatSpaceId(CHAT),
      projectSpaceId(PROJECT),
      'global',
    ]);
    expect(resolveSpaceIds('all', { botId: BOT })).toEqual([botSpaceId(BOT), 'global']);
    expect(resolveSpaceIds('bot', { botId: BOT, chatId: CHAT })).toEqual([botSpaceId(BOT)]);
    expect(resolveSpaceIds('chat', { botId: BOT, chatId: CHAT })).toEqual([chatSpaceId(CHAT)]);
  });

  it("'bot' / 'chat' 无对应上下文 → 明确报错", () => {
    expect(() => resolveSpaceIds('bot', { projectId: PROJECT })).toThrow(MemoryValidationError);
    expect(() => resolveSpaceIds('bot', { projectId: PROJECT })).toThrow(/Bot mode/);
    expect(() => resolveSpaceIds('chat', { botId: BOT })).toThrow(/chat/);
  });
});

describe('defaultCaptureSpace / distillSpaceId', () => {
  it('bot 会话默认 bot，否则 project', () => {
    expect(defaultCaptureSpace({ botId: BOT, projectId: PROJECT })).toBe('bot');
    expect(defaultCaptureSpace({ projectId: PROJECT })).toBe('project');
    expect(defaultCaptureSpace({})).toBe('project');
  });

  it('蒸馏归属：bot → 项目 → global', () => {
    expect(distillSpaceId({ botId: BOT, chatId: CHAT, projectId: PROJECT })).toBe(botSpaceId(BOT));
    expect(distillSpaceId({ projectId: PROJECT })).toBe(projectSpaceId(PROJECT));
    expect(distillSpaceId({ projectId: null })).toBe('global');
  });

  it('群聊会话蒸馏同时给出群空间，其余会话只有一个落点', () => {
    expect(distillSpaces({ botId: BOT, chatId: CHAT, projectId: PROJECT })).toEqual({
      self: botSpaceId(BOT),
      chat: chatSpaceId(CHAT),
    });
    expect(distillSpaces({ botId: BOT, projectId: PROJECT })).toEqual({ self: botSpaceId(BOT) });
    expect(distillSpaces({ chatId: CHAT, projectId: PROJECT })).toEqual({
      self: projectSpaceId(PROJECT),
    });
    expect(distillSpaces({ botId: BOT, chatId: '../x' })).toEqual({ self: botSpaceId(BOT) });
  });
});

describe('memorySpaceContext（会话权威 → 记忆上下文）', () => {
  it('普通会话只带项目', () => {
    expect(memorySpaceContext({ projectId: PROJECT })).toEqual({ projectId: PROJECT });
    expect(memorySpaceContext({ projectId: null })).toEqual({});
  });

  it('bot 会话带 botId，群聊带 chatId', () => {
    expect(memorySpaceContext({ projectId: PROJECT, bot: { botId: BOT, chatId: CHAT } })).toEqual({
      projectId: PROJECT,
      botId: BOT,
      chatId: CHAT,
    });
    expect(memorySpaceContext({ projectId: null, bot: { botId: BOT, chatId: null } })).toEqual({
      botId: BOT,
    });
  });

  it('bot 工作区不是 Code 项目（成员 / 群 home）时不带项目', () => {
    const isCodeProject = (id: string) => id !== PROJECT;
    expect(
      memorySpaceContext({ projectId: PROJECT, bot: { botId: BOT, chatId: CHAT } }, isCodeProject)
    ).toEqual({ botId: BOT, chatId: CHAT });
  });

  it('脏 botId / chatId 丢弃：非 uuid 不进上下文', () => {
    expect(memorySpaceContext({ projectId: PROJECT, bot: { botId: '../x', chatId: 'y' } })).toEqual(
      { projectId: PROJECT }
    );
    expect(memorySpaceContext({ projectId: null, bot: { botId: BOT, chatId: 'y' } })).toEqual({
      botId: BOT,
    });
  });
});

describe('秘书记忆空间', () => {
  const ctx = {
    projectId: SECRETARY,
    secretary: { sessionId: SESSION, projectIds: [VISIBLE, VISIBLE_2] },
  };

  it("'all' = 私有 + 可见项目 + global；'project' 只给私有空间", () => {
    expect(resolveSpaceIds('all', ctx)).toEqual([
      projectSpaceId(SECRETARY),
      projectSpaceId(VISIBLE),
      projectSpaceId(VISIBLE_2),
      'global',
    ]);
    expect(resolveSpaceIds('project', ctx)).toEqual([projectSpaceId(SECRETARY)]);
    expect(resolveSpaceIds('global', ctx)).toEqual(['global']);
  });

  it('可见项目里重复的、或就是私有项目本身的 id 只出现一次', () => {
    expect(
      resolveSpaceIds('all', {
        projectId: SECRETARY,
        secretary: { sessionId: SESSION, projectIds: [SECRETARY, VISIBLE, VISIBLE] },
      })
    ).toEqual([projectSpaceId(SECRETARY), projectSpaceId(VISIBLE), 'global']);
  });

  it('私有空间缺失（秘书项目还没登记）时只剩可见项目与 global', () => {
    expect(
      resolveSpaceIds('all', {
        projectId: null,
        secretary: { sessionId: SESSION, projectIds: [VISIBLE] },
      })
    ).toEqual([projectSpaceId(VISIBLE), 'global']);
    expect(
      resolveSpaceIds('project', {
        projectId: null,
        secretary: { sessionId: SESSION, projectIds: [] },
      })
    ).toEqual([]);
  });

  it('secretaryPrivateSpace：秘书给私有空间，其它会话没有限制', () => {
    expect(secretaryPrivateSpace(ctx)).toBe(projectSpaceId(SECRETARY));
    expect(secretaryPrivateSpace({ projectId: PROJECT })).toBeNull();
    expect(
      secretaryPrivateSpace({ projectId: null, secretary: { sessionId: SESSION, projectIds: [] } })
    ).toBeNull();
  });

  it('secretaryProjectIds：未完成设置按默认档案（全部可见）；all 只给用户自己的项目；列表取交集', () => {
    const projects = [
      { projectId: VISIBLE, state: 'active' as const },
      { projectId: VISIBLE_2, kind: 'local' as const, state: 'active' as const },
      { projectId: 'ssh-1', kind: 'ssh' as const, state: 'active' as const },
      { projectId: 'removed-1', state: 'removed' as const },
      { projectId: 'scratch-1', kind: 'scratch' as const, state: 'active' as const },
      { projectId: SECRETARY, kind: 'secretary' as const, state: 'active' as const },
      { projectId: 'bot-home-1', kind: 'bot-home' as const, state: 'active' as const },
    ];
    expect(secretaryProjectIds(null, projects)).toEqual([VISIBLE, VISIBLE_2, 'ssh-1']);
    expect(secretaryProjectIds({ visibleProjectIds: 'all' }, projects)).toEqual([
      VISIBLE,
      VISIBLE_2,
      'ssh-1',
    ]);
    expect(
      secretaryProjectIds({ visibleProjectIds: [VISIBLE_2, 'bot-home-1', 'removed-1'] }, projects)
    ).toEqual([VISIBLE_2]);
  });

  it('requestSpaceIds：projectId 指向可见项目时只给该项目空间，优先于检索缺省 all', () => {
    expect(requestSpaceIds('all', VISIBLE_2, ctx)).toEqual([projectSpaceId(VISIBLE_2)]);
    expect(requestSpaceIds('project', VISIBLE, ctx)).toEqual([projectSpaceId(VISIBLE)]);
    // 不给 projectId：与 resolveSpaceIds 同口径
    expect(requestSpaceIds('global', undefined, ctx)).toEqual(['global']);
    expect(requestSpaceIds('project', undefined, ctx)).toEqual([projectSpaceId(SECRETARY)]);
  });

  it('requestSpaceIds：不可见项目、秘书自己的项目、与其它 spaceId 混用都被拒', () => {
    expect(code(() => requestSpaceIds('all', PROJECT, ctx))).toBe('project_not_visible');
    expect(code(() => requestSpaceIds('project', SECRETARY, ctx))).toBe('project_not_visible');
    expect(code(() => requestSpaceIds('global', VISIBLE, ctx))).toBe('invalid_request');
    expect(code(() => requestSpaceIds('chat', VISIBLE, ctx))).toBe('invalid_request');
  });

  it('requestSpaceIds：非秘书会话（普通 / Bot）给 projectId 一律拒绝，不给则行为不变', () => {
    for (const plain of [{ projectId: PROJECT }, { projectId: PROJECT, botId: BOT }]) {
      expect(code(() => requestSpaceIds('project', PROJECT, plain))).toBe('project_scope');
      expect(requestSpaceIds('all', undefined, plain)).toEqual(resolveSpaceIds('all', plain));
    }
  });
});

function code(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(MemoryValidationError);
    return (error as MemoryValidationError).code;
  }
  return 'no error';
}
