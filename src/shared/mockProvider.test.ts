import { describe, expect, it } from 'vitest';
import {
  buildMockTurn,
  createMockProviderEntry,
  isMockProviderConfig,
  MOCK_API_KEY,
  MOCK_BASE_URL,
  MOCK_CHAT_MODEL_ID,
  MOCK_MODELS,
  MOCK_PROVIDER_ID,
  parseMockToolDirectives,
} from './mockProvider';

describe('isMockProviderConfig', () => {
  it('认 catalogId / 哨兵地址 / 占位 key，其它配置一律不是 mock', () => {
    expect(isMockProviderConfig({ catalogId: MOCK_PROVIDER_ID })).toBe(true);
    expect(isMockProviderConfig({ baseUrl: MOCK_BASE_URL, apiKey: 'anything' })).toBe(true);
    expect(isMockProviderConfig({ baseUrl: `${MOCK_BASE_URL}/`, apiKey: '' })).toBe(true);
    expect(
      isMockProviderConfig({ apiKey: MOCK_API_KEY, baseUrl: 'https://api.openai.com/v1' })
    ).toBe(true);
    expect(
      isMockProviderConfig({
        apiKey: 'sk-real',
        baseUrl: 'https://api.openai.com/v1',
      })
    ).toBe(false);
    expect(isMockProviderConfig({ apiKey: '', baseUrl: '' })).toBe(false);
    expect(isMockProviderConfig({})).toBe(false);
  });
});

describe('createMockProviderEntry', () => {
  it('写入可用占位凭证和内置模型，满足 has-credentials 判定', () => {
    const provider = createMockProviderEntry('mock-local');
    expect(provider).toMatchObject({
      id: 'mock-local',
      name: 'Mock',
      catalogId: MOCK_PROVIDER_ID,
      api: 'openai-completions',
      apiKey: MOCK_API_KEY,
      baseUrl: MOCK_BASE_URL,
      enabled: true,
    });
    expect(provider.models.map((model) => model.id)).toEqual(MOCK_MODELS.map((model) => model.id));
    expect(provider.models.every((model) => model.enabled !== false)).toBe(true);
    expect(provider.models.some((model) => model.id === MOCK_CHAT_MODEL_ID)).toBe(true);
  });
});

describe('parseMockToolDirectives', () => {
  it('从整轮文本抽出 [[tool:name {json}]]，坏 JSON 当空对象', () => {
    expect(
      parseMockToolDirectives(
        'please [[tool:read {"path":"a.ts"}]] then [[tool:bash {"command":"ls"}]]'
      )
    ).toEqual([
      { name: 'read', arguments: { path: 'a.ts' } },
      { name: 'bash', arguments: { command: 'ls' } },
    ]);
    expect(parseMockToolDirectives('[[tool:read not-json]]')).toEqual([
      { name: 'read', arguments: {} },
    ]);
    expect(parseMockToolDirectives('no tools here')).toEqual([]);
  });
});

describe('buildMockTurn', () => {
  it('无工具指令时返回包含用户原话的流式文本', () => {
    const turn = buildMockTurn([{ role: 'user', content: 'Add a dark-theme screenshot script.' }]);
    expect(turn.kind).toBe('text');
    if (turn.kind !== 'text') throw new Error('expected text turn');
    expect(turn.text).toContain('Add a dark-theme screenshot script.');
    expect(turn.text.toLowerCase()).toMatch(/mock|demo/);
  });

  it('有工具指令且尚无 toolResult 时返回 toolUse', () => {
    const turn = buildMockTurn([
      { role: 'user', content: 'Inspect [[tool:read {"path":"README.md"}]]' },
    ]);
    expect(turn).toEqual({
      kind: 'toolUse',
      calls: [{ name: 'read', arguments: { path: 'README.md' } }],
    });
  });

  it('已有 toolResult 时不再发工具，改为文本收尾', () => {
    const turn = buildMockTurn([
      { role: 'user', content: 'Inspect [[tool:read {"path":"README.md"}]]' },
      {
        role: 'toolResult',
        toolCallId: '1',
        toolName: 'read',
        content: [{ type: 'text', text: '#' }],
      },
    ]);
    expect(turn.kind).toBe('text');
    if (turn.kind !== 'text') throw new Error('expected text turn');
    expect(turn.text.length).toBeGreaterThan(0);
  });

  it('脏输入不崩：空消息、非对象、缺 content', () => {
    expect(buildMockTurn([]).kind).toBe('text');
    expect(buildMockTurn([null, 1, { role: 'system' }, { role: 'user' }]).kind).toBe('text');
  });
});
