import { describe, expect, it } from 'vitest';
import {
  BTW_TITLE_MAX_CHARS,
  btwDisabledTools,
  btwModelCandidates,
  btwTabTitle,
  buildBtwSystemPrompt,
  flattenBtwUserText,
  formatBtwHandoff,
  isBtwIsolationPrompt,
  lastAssistantText,
  parseBtwAbortRequest,
  parseBtwDisposeRequest,
  parseBtwPromptRequest,
  parseBtwSpawnRequest,
  snapshotMainConversation,
} from './btw';

const text = (role: string, value: string) => ({
  role,
  content: [{ type: 'text' as const, text: value }],
});

describe('snapshotMainConversation', () => {
  it('空消息得到空快照', () => {
    expect(snapshotMainConversation([])).toBe('');
  });

  it('只保留 user/assistant 正文，跳过工具和思考', () => {
    const snapshot = snapshotMainConversation([
      text('user', '修登录'),
      {
        role: 'assistant',
        content: [
          { type: 'thinking', text: 'secret' },
          { type: 'text', text: '先看 Auth.tsx' },
          { type: 'toolCall' },
        ],
      },
      { role: 'toolResult', content: [{ type: 'text', text: 'file body' }] },
      text('user', '继续'),
    ]);
    expect(snapshot).toBe(['User: 修登录', 'Assistant: 先看 Auth.tsx', 'User: 继续'].join('\n'));
    expect(snapshot).not.toContain('secret');
    expect(snapshot).not.toContain('file body');
  });

  it('只保留最近若干轮，丢弃更早的正文', () => {
    const messages = Array.from({ length: 50 }, (_, index) =>
      text(index % 2 === 0 ? 'user' : 'assistant', `m${index}`)
    );
    const snapshot = snapshotMainConversation(messages);
    expect(snapshot).not.toContain('m0');
    expect(snapshot).toContain('m49');
    expect(snapshot.split('\n')).toHaveLength(40);
  });
});

describe('buildBtwSystemPrompt', () => {
  it('contextual 带冻结主会话，并写明主 agent 看不见', () => {
    const prompt = buildBtwSystemPrompt('contextual', 'User: hi');
    expect(prompt).toMatch(/cannot see this thread/i);
    expect(prompt).toContain('User: hi');
    expect(prompt).toMatch(/background only/i);
    expect(prompt).not.toMatch(/do not call tools/i);
    expect(prompt).not.toMatch(/use workspace, file, and command tools/i);
    expect(prompt).toMatch(/Do not spawn subagents, coworkers, or workflows/i);
  });

  it('tangent 不含主会话快照', () => {
    const prompt = buildBtwSystemPrompt('tangent', 'User: hi');
    expect(prompt).toMatch(/cannot see this thread/i);
    expect(prompt).not.toContain('User: hi');
    expect(prompt).not.toMatch(/do not call tools/i);
    expect(prompt).not.toMatch(/use workspace, file, and command tools/i);
    expect(prompt).toMatch(/Do not spawn subagents, coworkers, or workflows/i);
  });
});

describe('isBtwIsolationPrompt', () => {
  it('识别旁路隔离说明，不误伤 coworker 短角色', () => {
    expect(isBtwIsolationPrompt(buildBtwSystemPrompt('tangent', 'User: hi'))).toBe(true);
    expect(isBtwIsolationPrompt(buildBtwSystemPrompt('contextual', 'User: hi'))).toBe(true);
    expect(isBtwIsolationPrompt('You are a scout. Stay read-only.')).toBe(false);
  });
});

describe('flattenBtwUserText', () => {
  it('无历史时就是当前问题', () => {
    expect(flattenBtwUserText([], '现在几点')).toBe('现在几点');
  });

  it('把已有问答垫在当前问题前面', () => {
    const text = flattenBtwUserText(
      [
        { role: 'user', text: 'q1' },
        { role: 'assistant', text: 'a1' },
      ],
      'q2'
    );
    expect(text).toContain('q1');
    expect(text).toContain('a1');
    expect(text.endsWith('q2')).toBe(true);
  });
});

describe('formatBtwHandoff', () => {
  it('包一层讨论上下文，而不是已完成工作', () => {
    const wrapped = formatBtwHandoff('用 Map 去重');
    expect(wrapped).toContain('用 Map 去重');
    expect(wrapped).toMatch(/not as work already completed/i);
  });

  it('空文本交回为空', () => {
    expect(formatBtwHandoff('  ')).toBe('');
  });
});

describe('btwTabTitle', () => {
  it('取第一问首行并截断', () => {
    expect(btwTabTitle('hello world')).toBe('hello world');
    const long = 'x'.repeat(BTW_TITLE_MAX_CHARS + 8);
    expect(btwTabTitle(long).length).toBe(BTW_TITLE_MAX_CHARS);
    expect(btwTabTitle('  line1\nline2  ')).toBe('line1');
  });
});

describe('btwModelCandidates', () => {
  it('会话模型优先，再全局默认，去重', () => {
    expect(
      btwModelCandidates(
        { defaultModel: { providerId: 'p1', modelId: 'm1' } },
        { providerId: 'p2', modelId: 'm2' }
      )
    ).toEqual([
      { providerId: 'p2', modelId: 'm2' },
      { providerId: 'p1', modelId: 'm1' },
    ]);
    expect(
      btwModelCandidates(
        { defaultModel: { providerId: 'p1', modelId: 'm1' } },
        { providerId: 'p1', modelId: 'm1' }
      )
    ).toEqual([{ providerId: 'p1', modelId: 'm1' }]);
  });

  it('忽略标题模型和脏条目', () => {
    expect(
      btwModelCandidates({
        titleSummaryModel: { providerId: 'title', modelId: 'cheap' },
        defaultModel: { providerId: '', modelId: 'x' },
      })
    ).toEqual([]);
  });
});

describe('parseBtwPromptRequest', () => {
  const valid = {
    requestId: 'r1',
    conversationId: 'c1',
    systemPrompt: 'sys',
    userText: 'hi',
  };

  it('收窄合法请求，可选 sessionModel', () => {
    expect(parseBtwPromptRequest(valid)).toEqual(valid);
    expect(
      parseBtwPromptRequest({
        ...valid,
        sessionModel: { providerId: 'p', modelId: 'm' },
      })
    ).toEqual({ ...valid, sessionModel: { providerId: 'p', modelId: 'm' } });
  });

  it('拒绝脏输入', () => {
    expect(parseBtwPromptRequest(null)).toBeNull();
    expect(parseBtwPromptRequest({ ...valid, requestId: '' })).toBeNull();
    expect(parseBtwPromptRequest({ ...valid, conversationId: 1 })).toBeNull();
    expect(parseBtwPromptRequest({ ...valid, userText: '  ' })).toBeNull();
    expect(parseBtwPromptRequest({ ...valid, sessionModel: { providerId: 'p' } })).toBeNull();
    expect(parseBtwPromptRequest({ ...valid, reasoningEnabled: 'yes' })).toBeNull();
    expect(parseBtwPromptRequest({ ...valid, thinkingLevel: 'nope' })).toBeNull();
  });

  it('收窄 reasoningEnabled 与 thinkingLevel', () => {
    expect(
      parseBtwPromptRequest({ ...valid, reasoningEnabled: true, thinkingLevel: 'high' })
    ).toEqual({
      ...valid,
      reasoningEnabled: true,
      thinkingLevel: 'high',
    });
    expect(parseBtwPromptRequest({ ...valid, reasoningEnabled: false })).toEqual({
      ...valid,
      reasoningEnabled: false,
    });
  });
});

describe('parseBtwAbortRequest', () => {
  it('只要非空 requestId', () => {
    expect(parseBtwAbortRequest({ requestId: 'r1' })).toEqual({ requestId: 'r1' });
    expect(parseBtwAbortRequest({ requestId: '' })).toBeNull();
    expect(parseBtwAbortRequest('r1')).toBeNull();
  });
});

describe('lastAssistantText', () => {
  it('取最后一条 assistant 正文', () => {
    expect(
      lastAssistantText([
        text('user', 'q'),
        text('assistant', 'first'),
        text('assistant', 'latest'),
      ])
    ).toBe('latest');
    expect(lastAssistantText([text('user', 'q')])).toBe('');
  });
});

describe('btwDisabledTools', () => {
  it('强制关闭 subagent 与 coworker，并保留已有禁用', () => {
    expect(btwDisabledTools(['memory'])).toEqual(['memory', 'subagent', 'coworker', 'workflow']);
    expect(btwDisabledTools(['coworker'])).toEqual(['coworker', 'subagent', 'workflow']);
  });
});

describe('parseBtwSpawnRequest', () => {
  const valid = {
    sessionId: 'btw-1',
    parentConversationId: 'parent-1',
    providerId: 'p',
    modelId: 'm',
    rolePrompt: 'You are aside',
  };

  it('收窄合法请求', () => {
    expect(parseBtwSpawnRequest(valid)).toEqual(valid);
    expect(
      parseBtwSpawnRequest({
        ...valid,
        reasoningEnabled: true,
        thinkingLevel: 'low',
        approvalMode: 'supervised',
      })
    ).toEqual({
      ...valid,
      reasoningEnabled: true,
      thinkingLevel: 'low',
      approvalMode: 'supervised',
    });
    expect(
      parseBtwSpawnRequest({
        ...valid,
        presetId: 'coding',
        loadLocalSkills: false,
      })
    ).toEqual({
      ...valid,
      presetId: 'coding',
      loadLocalSkills: false,
    });
  });

  it('拒绝脏值、coworker id 和自指', () => {
    expect(parseBtwSpawnRequest({ ...valid, sessionId: '' })).toBeNull();
    expect(parseBtwSpawnRequest({ ...valid, rolePrompt: '  ' })).toBeNull();
    expect(parseBtwSpawnRequest({ ...valid, thinkingLevel: 'nope' })).toBeNull();
    expect(parseBtwSpawnRequest({ ...valid, approvalMode: 'n' })).toBeNull();
    expect(parseBtwSpawnRequest({ ...valid, sessionId: 'p::cw-1' })).toBeNull();
    expect(parseBtwSpawnRequest({ ...valid, sessionId: 'parent-1' })).toBeNull();
    expect(parseBtwSpawnRequest({ ...valid, presetId: 1 })).toBeNull();
    expect(parseBtwSpawnRequest({ ...valid, loadLocalSkills: 'yes' })).toBeNull();
  });
});

describe('parseBtwDisposeRequest', () => {
  it('只要非空 sessionId', () => {
    expect(parseBtwDisposeRequest({ sessionId: 'btw-1' })).toEqual({ sessionId: 'btw-1' });
    expect(parseBtwDisposeRequest({ sessionId: '' })).toBeNull();
  });
});
