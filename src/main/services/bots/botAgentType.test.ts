import { describe, expect, it } from 'vitest';
import type { BotProfile } from '../../../shared/types/bot';
import { botToAgentType, listMemberAgentTypes, memberSpawnDescription } from './botAgentType';

const ID = '11111111-1111-4111-8111-111111111111';

function bot(overrides: Partial<BotProfile> = {}): BotProfile {
  return {
    id: ID,
    name: 'Alice',
    title: 'Reviewer',
    scope: 'Reviews pull requests',
    avatar: { color: '#888' },
    approvalMode: 'full',
    tools: 'all',
    skillIds: [],
    mcpServerIds: [],
    delegation: { canDelegateTo: 'any', acceptFrom: 'any' },
    memory: { enabled: true },
    createdAt: 1,
    updatedAt: 1,
    version: 1,
    ...overrides,
  } as BotProfile;
}

describe('botToAgentType', () => {
  it('成员档案映射为 bot:<id> 类型：名字、头衔/职责、人设提示与资源', () => {
    const entry = botToAgentType(
      bot({ tools: 'readonly', skillIds: ['s1'], mcpServerIds: ['m1'] }),
      'Be strict.'
    );
    expect(entry).toMatchObject({
      source: 'bot',
      typeKey: `bot:${ID}`,
      id: ID,
      name: 'Alice',
      description: 'Reviewer — Reviews pull requests',
      tools: 'readonly',
      modelMode: 'follow',
      skillIds: ['s1'],
      mcpServerIds: ['m1'],
    });
    expect(entry.systemPrompt).toContain('You are Alice (Reviewer).');
    expect(entry.systemPrompt).toContain('Reviews pull requests');
    expect(entry.systemPrompt).toContain('Be strict.');
    expect(entry).not.toHaveProperty('providerId');
  });

  it('engine 绑定为固定模型，thinkingLevel 开启推理', () => {
    expect(
      botToAgentType(bot({ engine: { providerId: 'p', modelId: 'm', thinkingLevel: 'high' } }), '')
    ).toMatchObject({
      modelMode: 'fixed',
      providerId: 'p',
      modelId: 'm',
      reasoning: 'on',
      thinkingLevel: 'high',
    });
    const plain = botToAgentType(bot({ engine: { providerId: 'p', modelId: 'm' } }), '');
    expect(plain).not.toHaveProperty('reasoning');
    expect(plain).not.toHaveProperty('thinkingLevel');
  });

  it('头衔与职责都空时描述回落为名字', () => {
    expect(botToAgentType(bot({ title: ' ', scope: '' }), '').description).toBe('Alice');
  });
});

describe('listMemberAgentTypes', () => {
  it('跳过已归档成员，只为在册成员读人设', () => {
    const archived = bot({ id: '22222222-2222-4222-8222-222222222222', archivedAt: 5 });
    const read: string[] = [];
    const list = listMemberAgentTypes([bot(), archived], (id) => {
      read.push(id);
      return 'persona';
    });
    expect(list.map((entry) => entry.typeKey)).toEqual([`bot:${ID}`]);
    expect(read).toEqual([ID]);
  });
});

describe('memberSpawnDescription', () => {
  it('worker 工具描述里带出成员名，让模型能把名字对应到 bot:<id>', () => {
    expect(memberSpawnDescription(botToAgentType(bot(), ''))).toBe(
      'Member "Alice" — Reviewer — Reviews pull requests'
    );
    expect(memberSpawnDescription(botToAgentType(bot({ title: '', scope: '' }), ''))).toBe(
      'Member "Alice"'
    );
  });
});
