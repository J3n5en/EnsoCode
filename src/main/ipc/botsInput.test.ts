import { describe, expect, it } from 'vitest';
import {
  parseAbilitySuggestRequest,
  parseBotDraftInput,
  parseBotUpdateInput,
  parseChatCloneInput,
  parseChatCreateInput,
  parseChatUpdateInput,
  parseGoalSuggestRequest,
  parseInboxUpdateInput,
  parseNotesSaveInput,
  parseNotesTargetInput,
  parseOpenWorkspaceInput,
  parsePersonaSuggestRequest,
  parseSendInput,
  parseSessionHistoryInput,
  parseTimelineInput,
} from './botsInput';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';

describe('parseBotDraftInput', () => {
  it('收窄合法草稿，engine:null 表示跟随全局默认', () => {
    expect(
      parseBotDraftInput({
        name: 'Alice',
        persona: 'p',
        approvalMode: 'supervised',
        tools: 'readonly',
        skillIds: ['s'],
        delegation: { canDelegateTo: 'any', acceptFrom: [A] },
        memory: { enabled: false },
        engine: null,
      })
    ).toEqual({
      name: 'Alice',
      persona: 'p',
      approvalMode: 'supervised',
      tools: 'readonly',
      skillIds: ['s'],
      delegation: { canDelegateTo: 'any', acceptFrom: [A] },
      memory: { enabled: false },
      engine: undefined,
    });
  });

  it('拒绝未知字段、错误类型与越界长度', () => {
    expect(parseBotDraftInput({ name: 'A', id: A })).toBeNull();
    expect(parseBotDraftInput({ tools: 'write' })).toBeNull();
    expect(parseBotDraftInput({ skillIds: [1] })).toBeNull();
    expect(parseBotDraftInput({ engine: { providerId: 'p' } })).toBeNull();
    expect(
      parseBotDraftInput({ delegation: { canDelegateTo: ['x'], acceptFrom: 'any' } })
    ).toBeNull();
    expect(parseBotDraftInput({ persona: 'x'.repeat(200_001) })).toBeNull();
    expect(parseBotDraftInput('Alice')).toBeNull();
  });

  it('日预算：正数上限，null / 空对象 = 不限，脏值拒绝', () => {
    expect(parseBotDraftInput({ budget: { dailyCostUsd: 1.5, dailyTokens: 1000 } })).toEqual({
      budget: { dailyCostUsd: 1.5, dailyTokens: 1000 },
    });
    expect(parseBotDraftInput({ budget: null })).toEqual({ budget: undefined });
    expect(parseBotDraftInput({ budget: {} })).toEqual({ budget: undefined });
    for (const budget of [
      { dailyCostUsd: -1 },
      { dailyTokens: 1.5 },
      { dailyTokens: '10' },
      { daily: 1 },
      'x',
    ])
      expect(parseBotDraftInput({ budget }), JSON.stringify(budget)).toBeNull();
  });

  it('委派时限：1..1440 的整数分钟，null = 默认，脏值拒绝', () => {
    expect(parseBotDraftInput({ delegationTimeoutMinutes: 45 })).toEqual({
      delegationTimeoutMinutes: 45,
    });
    expect(parseBotDraftInput({ delegationTimeoutMinutes: null })).toEqual({
      delegationTimeoutMinutes: undefined,
    });
    for (const bad of [0, 1441, 2.5, '45', {}])
      expect(parseBotDraftInput({ delegationTimeoutMinutes: bad })).toBeNull();
  });

  it('单回合 token 上限：正整数，null = 不限，脏值拒绝', () => {
    expect(parseBotDraftInput({ maxTokensPerTurn: 20_000 })).toEqual({ maxTokensPerTurn: 20_000 });
    expect(parseBotDraftInput({ maxTokensPerTurn: null })).toEqual({
      maxTokensPerTurn: undefined,
    });
    for (const bad of [0, -3, 2.5, '100', {}])
      expect(parseBotDraftInput({ maxTokensPerTurn: bad })).toBeNull();
  });

  it('更新请求带 botId 与可选 expectedVersion', () => {
    expect(parseBotUpdateInput({ botId: A, expectedVersion: 2, draft: { title: 't' } })).toEqual({
      botId: A,
      expectedVersion: 2,
      draft: { title: 't' },
    });
    expect(parseBotUpdateInput({ botId: 'x', draft: {} })).toBeNull();
  });
});

describe('chat inputs', () => {
  it('新建聊天：工作区只接受 member-home / chat-home / project+projectId', () => {
    expect(
      parseChatCreateInput({ kind: 'direct', members: [A], workspace: { kind: 'member-home' } })
    ).toEqual({
      kind: 'direct',
      title: '',
      members: [A],
      bossBotId: null,
      workspace: { kind: 'member-home' },
    });
    expect(
      parseChatCreateInput({
        kind: 'group',
        title: 'g',
        members: [A, B],
        bossBotId: A,
        workspace: { kind: 'chat-home' },
      })?.workspace
    ).toEqual({ kind: 'chat-home' });
    expect(
      parseChatCreateInput({ kind: 'group', members: [A, B], workspace: { kind: 'project' } })
    ).toBeNull();
    expect(
      parseChatCreateInput({
        kind: 'group',
        members: [A, B],
        workspace: { kind: 'chat-home', projectId: A },
      })
    ).toBeNull();
    expect(
      parseChatCreateInput({
        kind: 'direct',
        members: [A],
        workspace: { kind: 'member-home' },
        sessions: {},
      })
    ).toBeNull();
  });

  it('更新聊天：只收白名单字段', () => {
    expect(
      parseChatUpdateInput({ chatId: A, pinned: true, routing: { maxHops: 3 }, archived: false })
    ).toEqual({ chatId: A, pinned: true, routing: { maxHops: 3 }, archived: false });
    expect(parseChatUpdateInput({ chatId: A, sessions: {} })).toBeNull();
    expect(
      parseChatUpdateInput({
        chatId: A,
        settled: true,
        snoozedUntil: 1_700_000_000_000,
        pinOrder: 0,
      })
    ).toEqual({ chatId: A, settled: true, snoozedUntil: 1_700_000_000_000, pinOrder: 0 });
    expect(parseChatUpdateInput({ chatId: A, snoozedUntil: null, pinOrder: null })).toEqual({
      chatId: A,
      snoozedUntil: null,
      pinOrder: null,
    });
    for (const bad of [
      { settled: 'yes' },
      { snoozedUntil: 0 },
      { snoozedUntil: 1.5 },
      { snoozedUntil: '2026' },
      { pinOrder: -1 },
      { pinOrder: 1.2 },
    ])
      expect(parseChatUpdateInput({ chatId: A, ...bad })).toBeNull();
    expect(parseChatUpdateInput({ chatId: A, routing: { maxHops: 'x' } })).toBeNull();
  });

  it('routing.mode 只接受 boss / smart', () => {
    expect(parseChatUpdateInput({ chatId: A, routing: { mode: 'smart' } })).toEqual({
      chatId: A,
      routing: { mode: 'smart' },
    });
    expect(parseChatUpdateInput({ chatId: A, routing: { mode: 'boss' } })?.routing).toEqual({
      mode: 'boss',
    });
    expect(parseChatUpdateInput({ chatId: A, routing: { mode: 'auto' } })).toBeNull();
    expect(parseChatUpdateInput({ chatId: A, routing: { mode: 1 } })).toBeNull();
  });

  it('routing.muted 为成员 id 数组（去重）', () => {
    expect(parseChatUpdateInput({ chatId: A, routing: { muted: [A, A] } })?.routing).toEqual({
      muted: [A],
    });
    expect(parseChatUpdateInput({ chatId: A, routing: { muted: [] } })?.routing).toEqual({
      muted: [],
    });
    expect(parseChatUpdateInput({ chatId: A, routing: { muted: A } })).toBeNull();
    expect(parseChatUpdateInput({ chatId: A, routing: { muted: [1] } })).toBeNull();
  });
});

describe('send / timeline / workspace / history inputs', () => {
  it('发送需要 deliveryId，文本或图片至少一个', () => {
    expect(parseSendInput({ chatId: A, text: 'hi', deliveryId: 'd' })).toEqual({
      chatId: A,
      text: 'hi',
      deliveryId: 'd',
    });
    expect(parseSendInput({ chatId: A, text: 'hi' })).toBeNull();
    expect(parseSendInput({ chatId: A, text: '', deliveryId: 'd' })).toBeNull();
    expect(
      parseSendInput({
        chatId: A,
        text: '',
        deliveryId: 'd',
        images: [{ data: 'x', mimeType: 'image/png' }],
      })?.images
    ).toHaveLength(1);
    expect(parseSendInput({ chatId: A, text: 'x', deliveryId: 'd', images: [{}] })).toBeNull();
  });

  it('输入框引用只收标识符：文件相对路径、最多 3 个聊天、一个技能 id', () => {
    expect(
      parseSendInput({
        chatId: A,
        text: '',
        deliveryId: 'd',
        files: ['src/a.ts'],
        chats: [B, B],
        skill: 'skill-1',
      })
    ).toEqual({
      chatId: A,
      text: '',
      deliveryId: 'd',
      files: ['src/a.ts'],
      chats: [B],
      skill: 'skill-1',
    });
    const send = (extra: Record<string, unknown>) =>
      parseSendInput({ chatId: A, text: 'x', deliveryId: 'd', ...extra });
    const C = '33333333-3333-4333-8333-333333333333';
    const D = '44444444-4444-4444-8444-444444444444';
    expect(send({ chats: [A, B, C, D] })).toBeNull();
    expect(send({ chats: ['../x'] })).toBeNull();
    expect(send({ files: [1] })).toBeNull();
    expect(send({ files: Array.from({ length: 51 }, (_, i) => `f${i}`) })).toBeNull();
    expect(send({ skill: '' })).toBeNull();
    expect(send({ cwd: '/etc' })).toBeNull();
    expect(parseSendInput({ chatId: A, text: ' ', deliveryId: 'd', files: ['a'] })).toBeNull();
  });

  it('时间线分页把 limit 收在 1..200', () => {
    expect(parseTimelineInput({ chatId: A })).toEqual({ chatId: A, limit: 100 });
    expect(parseTimelineInput({ chatId: A, beforeSeq: 5, limit: 999 })).toEqual({
      chatId: A,
      beforeSeq: 5,
      limit: 200,
    });
    expect(parseTimelineInput({ chatId: A, beforeSeq: -1 })).toBeNull();
    expect(parseTimelineInput({ chatId: A, afterSeq: 0, limit: 20 })).toEqual({
      chatId: A,
      afterSeq: 0,
      limit: 20,
    });
    expect(parseTimelineInput({ chatId: A, afterSeq: 1, beforeSeq: 5 })).toBeNull();
    expect(parseTimelineInput({ chatId: A, afterSeq: 1.5 })).toBeNull();
  });

  it('打开工作区与会话历史只收标识符', () => {
    expect(parseChatCloneInput({ chatId: A, title: ' 副本 ' })).toEqual({
      chatId: A,
      title: '副本',
    });
    for (const bad of [
      null,
      { chatId: A },
      { chatId: A, title: '   ' },
      { chatId: A, title: 'x'.repeat(201) },
      { chatId: 'nope', title: 'x' },
      { chatId: A, title: 'x', members: [B] },
    ])
      expect(parseChatCloneInput(bad)).toBeNull();
    expect(parseOpenWorkspaceInput({ chatId: A })).toEqual({ chatId: A });
    expect(parseInboxUpdateInput({ key: 'budget:a:2026-10-04', action: 'dismiss' })).toEqual({
      key: 'budget:a:2026-10-04',
      action: 'dismiss',
    });
    expect(parseInboxUpdateInput({ key: 'k', action: 'reopen' })).toEqual({
      key: 'k',
      action: 'reopen',
    });
    for (const bad of [
      { key: '', action: 'dismiss' },
      { key: 'x'.repeat(301), action: 'dismiss' },
      { key: 'k', action: 'delete' },
      { key: 'k', action: 'dismiss', extra: 1 },
      null,
    ])
      expect(parseInboxUpdateInput(bad)).toBeNull();
    expect(parseOpenWorkspaceInput({ botId: A })).toEqual({ botId: A });
    expect(parseOpenWorkspaceInput({ chatId: A, botId: A })).toBeNull();
    expect(parseOpenWorkspaceInput({ path: '/etc' })).toBeNull();
    expect(parseSessionHistoryInput({ conversationId: A, beforeIndex: 3 })).toEqual({
      conversationId: A,
      beforeIndex: 3,
    });
    expect(parseSessionHistoryInput({ conversationId: '../x' })).toBeNull();
  });
});

describe('parseAbilitySuggestRequest', () => {
  it('收窄成员描述，缺省字段补空串、语言缺省 en', () => {
    expect(parseAbilitySuggestRequest({ name: 'Rex', scope: 'Reviews', botId: A })).toEqual({
      profile: { name: 'Rex', title: '', scope: 'Reviews', persona: '' },
      language: 'en',
      botId: A,
    });
    expect(parseAbilitySuggestRequest({ name: 'Rex', language: 'zh' })?.language).toBe('zh');
  });

  it('拒绝多余字段、非法 id、超长文本和全空描述', () => {
    expect(parseAbilitySuggestRequest({ name: 'Rex', skills: [] })).toBeNull();
    expect(parseAbilitySuggestRequest({ name: 'Rex', botId: '../x' })).toBeNull();
    expect(parseAbilitySuggestRequest({ name: 'Rex', language: 'fr' })).toBeNull();
    expect(parseAbilitySuggestRequest({ name: 'x'.repeat(201) })).toBeNull();
    expect(parseAbilitySuggestRequest({ name: ' ', scope: '' })).toBeNull();
    expect(parseAbilitySuggestRequest(null)).toBeNull();
  });
});

describe('parseGoalSuggestRequest', () => {
  const template = { id: 'software', title: '软件开发小队', summary: '前后端测试' };
  it('目标必填，模板清单缺省为空，语言缺省 en', () => {
    expect(parseGoalSuggestRequest({ goal: '写周报' })).toEqual({
      goal: '写周报',
      language: 'en',
      templates: [],
    });
    expect(parseGoalSuggestRequest({ goal: 'x', language: 'zh', templates: [template] })).toEqual({
      goal: 'x',
      language: 'zh',
      templates: [template],
    });
  });

  it('接受自定义模板 id 与最多 30 个模板', () => {
    const custom = { ...template, id: 'custom:11111111-2222-4333-8444-555555555555' };
    const many = Array.from({ length: 30 }, (_, i) => ({ ...template, id: `t${i}` }));
    expect(parseGoalSuggestRequest({ goal: 'x', templates: [custom] })?.templates).toEqual([
      custom,
    ]);
    expect(parseGoalSuggestRequest({ goal: 'x', templates: many })?.templates).toHaveLength(30);
  });

  it('拒绝空目标、超长、多余字段、坏模板与非法语言', () => {
    for (const bad of [
      null,
      'goal',
      { goal: '  ' },
      { goal: 'x'.repeat(2_001) },
      { goal: 'x', extra: 1 },
      { goal: 'x', language: 'fr' },
      { goal: 'x', templates: 'software' },
      { goal: 'x', templates: [{ ...template, id: '../etc' }] },
      { goal: 'x', templates: [{ ...template, id: 'custom:x' }] },
      { goal: 'x', templates: [{ ...template, extra: 1 }] },
      { goal: 'x', templates: [{ id: 'a', title: 'b' }] },
      {
        goal: 'x',
        templates: Array.from({ length: 31 }, (_, i) => ({ ...template, id: `t${i}` })),
      },
    ])
      expect(parseGoalSuggestRequest(bad), JSON.stringify(bad)).toBeNull();
  });
});

describe('parsePersonaSuggestRequest', () => {
  it('名称和角色必填，其余缺省空串、语言缺省 en', () => {
    expect(parsePersonaSuggestRequest({ name: '阿运', title: '运维' })).toEqual({
      name: '阿运',
      title: '运维',
      scope: '',
      persona: '',
      language: 'en',
    });
    expect(
      parsePersonaSuggestRequest({
        name: 'a',
        title: 'b',
        scope: 's',
        persona: 'p',
        language: 'zh',
      })
    ).toMatchObject({ scope: 's', persona: 'p', language: 'zh' });
  });

  it('拒绝缺名称或角色、多余字段、超长和非法语言', () => {
    expect(parsePersonaSuggestRequest({ name: '阿运', title: ' ' })).toBeNull();
    expect(parsePersonaSuggestRequest({ title: '运维' })).toBeNull();
    expect(parsePersonaSuggestRequest({ name: 'a', title: 'b', botId: A })).toBeNull();
    expect(parsePersonaSuggestRequest({ name: 'a', title: 'x'.repeat(201) })).toBeNull();
    expect(parsePersonaSuggestRequest({ name: 'a', title: 'b', language: 'fr' })).toBeNull();
    expect(parsePersonaSuggestRequest(null)).toBeNull();
  });
});

describe('notes inputs', () => {
  it('目标只收 botId 或 chatId 之一', () => {
    expect(parseNotesTargetInput({ botId: A })).toEqual({ kind: 'bot', id: A });
    expect(parseNotesTargetInput({ chatId: B })).toEqual({ kind: 'chat', id: B });
    for (const bad of [null, 'x', {}, { botId: A, chatId: B }, { botId: 'x' }, { path: '/tmp' }])
      expect(parseNotesTargetInput(bad)).toBeNull();
  });
  it('保存需要正文与 version，拒绝非字符串和超长正文', () => {
    expect(parseNotesSaveInput({ botId: A, content: '- a', version: 'v' })).toEqual({
      target: { kind: 'bot', id: A },
      content: '- a',
      version: 'v',
    });
    expect(parseNotesSaveInput({ chatId: B, content: '', version: '' })).toMatchObject({
      target: { kind: 'chat', id: B },
    });
    for (const bad of [
      { botId: A, content: '- a' },
      { botId: A, content: 1, version: 'v' },
      { botId: A, content: 'x'.repeat(100_001), version: 'v' },
      { botId: A, content: '', version: 'v'.repeat(200) },
      { botId: A, chatId: B, content: '', version: '' },
      { botId: A, content: '', version: '', extra: 1 },
    ])
      expect(parseNotesSaveInput(bad)).toBeNull();
  });
});
