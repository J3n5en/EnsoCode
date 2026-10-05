import { describe, expect, it } from 'vitest';
import { buildCharacterCard, parseCharacterCard, sanitizeBotName } from './characterCard';

describe('sanitizeBotName', () => {
  it('空白转下划线、去掉非法字符并截断到 24 字', () => {
    expect(sanitizeBotName(' Dr. Who ')).toBe('Dr_Who');
    expect(sanitizeBotName('林 经理!')).toBe('林_经理');
    expect([...sanitizeBotName('a'.repeat(40))]).toHaveLength(24);
    expect(sanitizeBotName('!!!')).toBe('');
  });
});

describe('parseCharacterCard', () => {
  it('解析 SillyTavern V2 的 data 字段生成草稿', () => {
    const card = JSON.stringify({
      spec: 'chara_card_v2',
      spec_version: '2.0',
      data: {
        name: 'Aria Stone',
        description: '{{char}} is a careful reviewer. Loves tests.',
        personality: 'Calm, precise',
        scenario: 'Helps {{user}} ship releases',
      },
    });
    const result = parseCharacterCard(card);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.draft.name).toBe('Aria_Stone');
    expect(result.draft.scope).toBe('Aria Stone is a careful reviewer.');
    expect(result.draft.persona).toContain('Aria Stone is a careful reviewer. Loves tests.');
    expect(result.draft.persona).toContain('Calm, precise');
    expect(result.draft.persona).toContain('Helps the user ship releases');
  });

  it('兼容 V1 顶层字段', () => {
    const result = parseCharacterCard(JSON.stringify({ name: 'Bob', description: 'Ops guy' }));
    expect(result.ok && result.draft.name).toBe('Bob');
  });

  it('坏 JSON 与非人物卡分别报错', () => {
    expect(parseCharacterCard('{')).toEqual({ ok: false, error: 'invalid-json' });
    expect(parseCharacterCard('[1]')).toEqual({ ok: false, error: 'not-a-card' });
    expect(parseCharacterCard(JSON.stringify({ data: { description: 'x' } }))).toEqual({
      ok: false,
      error: 'not-a-card',
    });
  });
});

describe('buildCharacterCard', () => {
  const bot = {
    name: 'Aria',
    title: '测试',
    scope: 'Reviews PRs. Writes tests.',
    avatar: { color: '#22c55e', image: 3 },
    tools: 'readonly' as const,
    approvalMode: 'supervised' as const,
    memory: { enabled: false },
    skillIds: ['skill-1'],
    mcpServerIds: ['mcp-1'],
    engine: { providerId: 'p', modelId: 'm' },
  };
  const persona = 'You are Aria.\n\nPersonality: strict';

  it('生成 SillyTavern V2 卡，专有字段放 extensions.enso，不含技能 / MCP / 模型', () => {
    const card = buildCharacterCard(bot, persona);
    expect(card.spec).toBe('chara_card_v2');
    expect(card.data).toMatchObject({ name: 'Aria', description: persona, scenario: bot.scope });
    expect(card.data.extensions.enso).toEqual({
      title: '测试',
      scope: bot.scope,
      color: '#22c55e',
      tools: 'readonly',
      approvalMode: 'supervised',
      memory: false,
    });
    const text = JSON.stringify(card);
    expect(text).not.toContain('skill-1');
    expect(text).not.toContain('mcp-1');
    expect(text).not.toContain('"modelId"');
  });

  it('导入自己导出的卡还原人设与专有字段', () => {
    const result = parseCharacterCard(JSON.stringify(buildCharacterCard(bot, persona)));
    expect(result).toEqual({
      ok: true,
      draft: {
        name: 'Aria',
        title: '测试',
        scope: bot.scope,
        persona,
        color: '#22c55e',
        tools: 'readonly',
        approvalMode: 'supervised',
        memoryEnabled: false,
      },
    });
  });

  it('专有字段非法时逐项忽略', () => {
    const card = buildCharacterCard(bot, persona) as unknown as {
      data: { extensions: { enso: Record<string, unknown> } };
    };
    card.data.extensions.enso = { title: 7, color: 'red', tools: 'root', approvalMode: 'x' };
    const result = parseCharacterCard(JSON.stringify(card));
    expect(result.ok && result.draft).toEqual({
      name: 'Aria',
      title: '',
      scope: 'You are Aria.',
      persona,
    });
  });
});
