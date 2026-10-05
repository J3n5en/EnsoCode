import { describe, expect, it } from 'vitest';
import {
  agentTypeDisplayName,
  buildAgentTypeRegistrySnapshot,
  ENSO_AGENT_TYPE_KEY,
  ENSO_LOCKED_PROFILE,
  isReservedAgentTypeName,
  isSameChildSessionIdentity,
  isSameSessionIdentity,
  normalizeAgentTypeName,
  parseAgentTypeCandidate,
  parseAgentTypeKey,
  parseAgentTypeRegistrySnapshot,
} from './builtinAgents';

const CUSTOM_ID = '11111111-1111-4111-8111-111111111111';
const BOT_ID = '33333333-3333-4333-8333-333333333333';

describe('agentTypeDisplayName', () => {
  const custom = [{ id: CUSTOM_ID, name: '  reviewer-x ' }];

  it('maps type keys to human-readable names', () => {
    expect(agentTypeDisplayName(`custom:${CUSTOM_ID}`, custom)).toBe('reviewer-x');
    expect(agentTypeDisplayName('builtin:scout', custom)).toBe('scout');
    expect(agentTypeDisplayName(ENSO_AGENT_TYPE_KEY, custom)).toBe('Enso');
  });

  it('keeps legacy plain names and falls back for unknown custom ids', () => {
    expect(agentTypeDisplayName('worker', custom)).toBe('worker');
    expect(agentTypeDisplayName('custom:22222222-2222-4222-8222-222222222222', custom)).toBe(
      'custom'
    );
  });
});

describe('AgentType registry and locked Enso profile', () => {
  it('Enso 固定 locked/non-disableable/no override 并精确三 tools', () => {
    expect(ENSO_LOCKED_PROFILE).toEqual({
      profileId: 'enso-locked-v1',
      typeKey: 'agent:enso',
      agentId: 'enso',
      inheritParentModel: true,
      systemPromptId: 'enso-system-v1',
      toolIds: ['enso_capabilities', 'enso_app', 'ask_user'],
      skillPaths: [],
      mcpServers: [],
    });
    const snapshot = buildAgentTypeRegistrySnapshot({
      revision: 2,
      disabledBuiltinAgentTypes: [],
      customAgentTypes: [],
    });
    expect(snapshot.candidates[0]).toMatchObject({
      typeKey: ENSO_AGENT_TYPE_KEY,
      displayName: 'Enso',
      source: 'system',
      locked: true,
      canDisable: false,
      canEdit: false,
    });
  });

  it('保留名归一化/case-fold 供 settings 与 Main 共用', () => {
    expect(normalizeAgentTypeName('  ＥＮＳＯ  ')).toBe('enso');
    for (const name of ['Enso', ' ENSO ', 'agent:foo', 'builtin:scout', 'custom:x']) {
      expect(isReservedAgentTypeName(name), name).toBe(true);
    }
    expect(isReservedAgentTypeName('reviewer')).toBe(false);
  });

  it('registry 过滤 disabled builtin/非法 custom；同名合法 custom 覆盖 builtin', () => {
    const snapshot = buildAgentTypeRegistrySnapshot({
      revision: 3,
      disabledBuiltinAgentTypes: ['worker'],
      customAgentTypes: [
        {
          id: CUSTOM_ID,
          name: 'scout',
          description: 'Custom scout',
          systemPrompt: 'Custom',
          tools: 'readonly',
        },
        {
          id: '22222222-2222-4222-8222-222222222222',
          name: 'EnSo',
          description: 'Illegal override',
          systemPrompt: 'No',
          tools: 'all',
        },
      ],
    });
    expect(snapshot.candidates.map((candidate) => candidate.typeKey)).toEqual([
      'agent:enso',
      'builtin:reviewer',
      'builtin:tester',
      `custom:${CUSTOM_ID}`,
    ]);
    expect(parseAgentTypeRegistrySnapshot(snapshot)).toEqual(snapshot);

    // 非法 custom（非 UUID id）不产生覆盖：builtin 保留
    const withIllegal = buildAgentTypeRegistrySnapshot({
      revision: 4,
      disabledBuiltinAgentTypes: [],
      customAgentTypes: [
        {
          id: 'not-a-uuid',
          name: 'scout',
          description: 'x',
          systemPrompt: 'x',
          tools: 'readonly',
        },
      ],
    });
    expect(withIllegal.candidates.map((candidate) => candidate.typeKey)).toContain('builtin:scout');

    // 覆盖名称对比徽 trim + 大小写不敏感（与 reserved 名校验同口径）
    const caseInsensitive = buildAgentTypeRegistrySnapshot({
      revision: 5,
      disabledBuiltinAgentTypes: [],
      customAgentTypes: [
        {
          id: CUSTOM_ID,
          name: ' Scout ',
          description: 'x',
          systemPrompt: 'x',
          tools: 'readonly',
        },
      ],
    });
    expect(caseInsensitive.candidates.map((candidate) => candidate.typeKey)).not.toContain(
      'builtin:scout'
    );
  });

  it('type key 严格拒绝未知形态与 reserved custom', () => {
    expect(parseAgentTypeKey('agent:enso')).toBe('agent:enso');
    expect(parseAgentTypeKey('builtin:scout')).toBe('builtin:scout');
    expect(parseAgentTypeKey(`custom:${CUSTOM_ID}`)).toBe(`custom:${CUSTOM_ID}`);
    expect(parseAgentTypeKey(`bot:${BOT_ID}`)).toBe(`bot:${BOT_ID}`);

    for (const value of [
      'agent:worker',
      'builtin:general',
      'builtin:enso',
      'custom:enso',
      'bot:alice',
      'scout',
    ]) {
      expect(parseAgentTypeKey(value), value).toBeNull();
    }
  });

  it('成员登记为 bot:<id>，内置/自定义同名时以它们为准并跳过成员', () => {
    expect(isReservedAgentTypeName('bot:x')).toBe(true);
    const member = (id: string, name: string) => ({ id, name, description: 'desc' });
    const snapshot = buildAgentTypeRegistrySnapshot({
      revision: 6,
      disabledBuiltinAgentTypes: ['worker'],
      customAgentTypes: [
        { id: CUSTOM_ID, name: 'Helper', description: 'x', systemPrompt: 'x', tools: 'all' },
      ],
      members: [
        member(BOT_ID, ' Alice '),
        member('44444444-4444-4444-8444-444444444444', 'Worker'),
        member('55555555-5555-4555-8555-555555555555', 'helper'),
        member('66666666-6666-4666-8666-666666666666', 'ENSO'),
        member('77777777-7777-4777-8777-777777777777', 'alice'),
        member('not-a-uuid', 'Bob'),
      ],
    });
    const bots = snapshot.candidates.filter((candidate) => candidate.source === 'bot');
    expect(bots).toEqual([
      {
        typeKey: `bot:${BOT_ID}`,
        displayName: 'Alice',
        description: 'desc',
        source: 'bot',
        locked: false,
        canDisable: false,
        canEdit: false,
      },
    ]);
    expect(parseAgentTypeRegistrySnapshot(snapshot)).toEqual(snapshot);
    expect(parseAgentTypeCandidate({ ...bots[0], typeKey: 'custom:x' })).toBeNull();
  });

  it('generation 对比 helper 拒绝同 session 的旧 parent/child generation', () => {
    const parent = {
      sessionId: 'parent',
      generation: '11111111-1111-4111-8111-111111111111',
    };
    const child = {
      sessionId: 'parent::cw-1',
      generation: '22222222-2222-4222-8222-222222222222',
      parent,
      instanceId: '33333333-3333-4333-8333-333333333333',
      instanceName: 'Enso 3333',
      typeKey: 'agent:enso' as const,
      profileId: 'enso-locked-v1' as const,
    };
    expect(isSameSessionIdentity(parent, parent)).toBe(true);
    expect(
      isSameSessionIdentity(parent, {
        ...parent,
        generation: '44444444-4444-4444-8444-444444444444',
      })
    ).toBe(false);
    expect(isSameChildSessionIdentity(child, child)).toBe(true);
    expect(
      isSameChildSessionIdentity(child, {
        ...child,
        generation: '55555555-5555-4555-8555-555555555555',
      })
    ).toBe(false);
  });
});
