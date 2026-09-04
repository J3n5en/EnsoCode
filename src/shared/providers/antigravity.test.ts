import { OAUTH_LABEL_MAX_LENGTH } from '@shared/types';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ANTIGRAVITY_FALLBACK_MODELS,
  ANTIGRAVITY_LOGICAL_MODELS,
  ANTIGRAVITY_PROVIDER_ID,
  ANTIGRAVITY_WIRE_MAX_OUTPUT_TOKENS,
  antigravityExpiryFromSeconds,
  antigravityProviderConfig,
  antigravityWireIds,
  buildRequest,
  defaultAntigravityProjectId,
  extractAntigravityProjectId,
  isAccessTokenExpired,
  iterateSseJson,
  mergeAntigravityModels,
  normalizeToolSchema,
  parseAntigravityApiKey,
  parseAntigravityManifestVersion,
  parseAvailableModels,
  parseUsageWindows,
  planAntigravityProjectDiscovery,
  resolveAntigravityWireModelId,
  sanitizeUpstreamBody,
} from './antigravity';
import { startOauthCallbackServer } from './callbackServer';
import { createEventStream, emptyUsage, type PiAssistantMessage } from './piProviderTypes';

const encoder = new TextEncoder();
const chunksOf = (...parts: string[]): Uint8Array[] => parts.map((part) => encoder.encode(part));

async function collect<T>(source: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of source) out.push(item);
  return out;
}

describe('凭证过期判定', () => {
  it('落库的 expires 预扣 60 秒刷新提前量', () => {
    expect(antigravityExpiryFromSeconds(3600, 1_000_000)).toBe(1_000_000 + 3_600_000 - 60_000);
  });

  it('到达 expires 那一刻即算过期', () => {
    const expires = antigravityExpiryFromSeconds(3600, 0);
    expect(isAccessTokenExpired(expires, expires - 1)).toBe(false);
    expect(isAccessTokenExpired(expires, expires)).toBe(true);
  });

  it('真实 60 秒边界：token 还有 61 秒寿命时不算过期，59 秒时算过期', () => {
    const issuedAt = 10_000_000;
    const expires = antigravityExpiryFromSeconds(3600, issuedAt);
    const realExpiry = issuedAt + 3_600_000;
    expect(isAccessTokenExpired(expires, realExpiry - 61_000)).toBe(false);
    expect(isAccessTokenExpired(expires, realExpiry - 59_000)).toBe(true);
  });

  it('缺失或非法的 expires 保守视为过期', () => {
    expect(isAccessTokenExpired(undefined, 0)).toBe(true);
    expect(isAccessTokenExpired(Number.NaN, 0)).toBe(true);
  });
});

describe('Antigravity 项目发现', () => {
  it('从 loadCodeAssist 的多种字段取出已有 project', () => {
    expect(extractAntigravityProjectId({ cloudaicompanionProject: 'proj-1' })).toBe('proj-1');
    expect(extractAntigravityProjectId({ projectId: 'proj-2' })).toBe('proj-2');
    expect(
      extractAntigravityProjectId({
        cloudaicompanionProjects: [{ id: 'nested-1' }],
      })
    ).toBe('nested-1');
  });

  it('已有 project 时即使 free-tier 地区不可用也不阻断', () => {
    expect(
      planAntigravityProjectDiscovery({
        cloudaicompanionProject: 'proj-1',
        ineligibleTiers: [
          {
            tierId: 'free-tier',
            reasonMessage:
              'Your current account is not eligible for Antigravity, because it is not currently available in your location.',
          },
        ],
      })
    ).toEqual({ action: 'use-project', projectId: 'proj-1' });
  });

  it('没有 project 且地区不可用时退回默认 project，而不是抛错', () => {
    expect(
      planAntigravityProjectDiscovery({
        allowedTiers: [],
        ineligibleTiers: [
          {
            tierId: 'free-tier',
            reasonMessage:
              'Your current account is not eligible for Antigravity, because it is not currently available in your location.',
          },
        ],
      })
    ).toEqual({ action: 'fallback-default' });
  });

  it('明确允许 free-tier 且尚未开通时才走 onboard', () => {
    expect(
      planAntigravityProjectDiscovery({
        allowedTiers: [{ id: 'free-tier' }],
      })
    ).toEqual({ action: 'onboard' });
  });

  it('默认 project 对同一邮箱稳定，便于与 pi-antigravity 对齐', () => {
    const a = defaultAntigravityProjectId('user@example.com');
    const b = defaultAntigravityProjectId('user@example.com');
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(defaultAntigravityProjectId('other@example.com')).not.toBe(a);
  });
});

describe('parseAntigravityApiKey', () => {
  it('取出 access 与 projectId', () => {
    const parsed = parseAntigravityApiKey(
      JSON.stringify({ access: 'tok', refresh: 'r', expires: 42, projectId: 'p-1', email: 'a@b.c' })
    );
    expect(parsed).toEqual({
      access: 'tok',
      refresh: 'r',
      expires: 42,
      projectId: 'p-1',
      email: 'a@b.c',
    });
  });

  it.each([
    ['非 JSON', 'not json'],
    ['JSON 但不是对象', 'null'],
    ['缺 projectId', JSON.stringify({ access: 'tok' })],
    ['缺 access', JSON.stringify({ projectId: 'p-1' })],
    ['字段类型不符', JSON.stringify({ access: 123, projectId: {} })],
  ])('%s 时抛可读错误而不是原始异常', (_label, input) => {
    expect(() => parseAntigravityApiKey(input)).toThrowError(/Antigravity 凭证/);
  });
});

describe('parseAvailableModels', () => {
  it('把 fetchAvailableModels 的条目归一化成模型清单', () => {
    const specs = parseAvailableModels({
      models: {
        'gemini-3.1-pro': {
          displayName: 'Gemini 3.1 Pro',
          supportsThinking: true,
          supportsImages: true,
          maxTokens: 1_048_576,
          maxOutputTokens: 65_535,
        },
        'claude-opus-4-6': {
          displayName: 'Claude Opus 4.6',
          supportsThinking: true,
          maxTokens: 250_000,
          maxOutputTokens: 64_000,
        },
      },
    });
    expect(specs.map((spec) => spec.id)).toEqual(['claude-opus-4-6', 'gemini-3.1-pro']);
    const gemini = specs.find((spec) => spec.id === 'gemini-3.1-pro');
    expect(gemini).toMatchObject({
      name: 'Gemini 3.1 Pro',
      reasoning: true,
      input: ['text', 'image'],
      contextWindow: 1_048_576,
      maxTokens: 65_535,
    });
    // 没有 supportsImages 的条目只声明文本输入
    expect(specs.find((spec) => spec.id === 'claude-opus-4-6')?.input).toEqual(['text']);
  });

  it('滤掉内部模型与补全用的 checkpoint 模型', () => {
    const specs = parseAvailableModels({
      models: {
        'gemini-3-pro': { displayName: 'Gemini 3 Pro' },
        'secret-model': { displayName: 'Secret', isInternal: true },
        tab_flash_lite_preview: { displayName: 'Tab' },
        'gemini-2.5-pro': { displayName: 'Gemini 2.5 Pro' },
      },
    });
    expect(specs.map((spec) => spec.id)).toEqual(['gemini-2.5-pro', 'gemini-3-pro']);
  });

  it('缺字段的条目退到默认窗口而不是 NaN', () => {
    const specs = parseAvailableModels({ models: { 'weird-model': {} } });
    expect(specs).toHaveLength(1);
    expect(specs[0]).toMatchObject({
      id: 'weird-model',
      name: 'weird-model',
      reasoning: false,
      contextWindow: 200_000,
      maxTokens: 64_000,
    });
  });

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['字符串', 'boom'],
    ['数组', []],
    ['没有 models 字段', { agentModelSorts: [] }],
    ['models 是数组', { models: [] }],
    ['models 是字符串', { models: 'nope' }],
  ])('脏输入 %s 返回空数组而不抛', (_label, payload) => {
    expect(parseAvailableModels(payload)).toEqual([]);
  });

  it('models 里混入 null / 非对象条目时跳过而不崩', () => {
    const specs = parseAvailableModels({
      models: { good: { displayName: 'Good' }, bad: null, worse: 'nope', 'also-bad': 3 },
    });
    expect(specs.map((spec) => spec.id)).toEqual(['good']);
  });

  it('负数或非数字的 token 上限退到默认值', () => {
    const specs = parseAvailableModels({
      models: { m: { maxTokens: -1, maxOutputTokens: 'lots' } },
    });
    expect(specs[0]).toMatchObject({ contextWindow: 200_000, maxTokens: 64_000 });
  });
});

describe('SSE 分块解析', () => {
  it('按 data: 事件切分并 JSON.parse', async () => {
    const events = await collect(
      iterateSseJson(
        chunksOf(
          'data: {"response":{"candidates":[{"content":{"parts":[{"text":"hi"}]}}]}}\n\n',
          'data: {"response":{"candidates":[{"finishReason":"STOP"}]}}\n\n'
        )
      )
    );
    expect(events).toHaveLength(2);
    expect(events[0].response?.candidates?.[0].content?.parts?.[0].text).toBe('hi');
    expect(events[1].response?.candidates?.[0].finishReason).toBe('STOP');
  });

  it('分块边界落在 JSON 中间时能拼回来', async () => {
    // 真实场景：TCP 分片会把一条 SSE 事件劈成任意两半
    const events = await collect(
      iterateSseJson(
        chunksOf('data: {"response":{"cand', 'idates":[{"finishReason":"STOP"}]}}\n\n')
      )
    );
    expect(events).toHaveLength(1);
    expect(events[0].response?.candidates?.[0].finishReason).toBe('STOP');
  });

  it('分块边界落在事件分隔符中间时不丢事件', async () => {
    const events = await collect(
      iterateSseJson(chunksOf('data: {"traceId":"a"}\n', '\ndata: {"traceId":"b"}\n\n'))
    );
    expect(events).toHaveLength(2);
  });

  it('末尾没有空行的事件也会被吐出来', async () => {
    const events = await collect(iterateSseJson(chunksOf('data: {"error":{"code":429}}')));
    expect(events[0].error?.code).toBe(429);
  });

  it('多行 data 拼成同一个 JSON', async () => {
    const events = await collect(
      iterateSseJson(chunksOf('data: {"response":\ndata: {"candidates":[]}}\n\n'))
    );
    expect(events).toHaveLength(1);
    expect(events[0].response?.candidates).toEqual([]);
  });

  it('CRLF 换行同样能切', async () => {
    const events = await collect(iterateSseJson(chunksOf('data: {"traceId":"a"}\r\n\r\n')));
    expect(events).toHaveLength(1);
  });

  it('[DONE]、注释行、非 JSON 事件体都跳过而不抛', async () => {
    const events = await collect(
      iterateSseJson(
        chunksOf(
          ': keep-alive\n\n',
          'data: [DONE]\n\n',
          'data: not json at all\n\n',
          'data: {"traceId":"ok"}\n\n'
        )
      )
    );
    expect(events).toHaveLength(1);
  });

  it('空流产出空序列', async () => {
    expect(await collect(iterateSseJson([]))).toEqual([]);
  });
});

describe('normalizeToolSchema', () => {
  it('去掉 Google 不认的关键字并补上 object 的 properties', () => {
    expect(
      normalizeToolSchema({
        $schema: 'https://json-schema.org/draft/2020-12/schema',
        type: 'object',
        additionalProperties: false,
      })
    ).toEqual({ type: 'object', properties: {} });
  });

  it('const 折成单值 enum，oneOf 改写成 anyOf', () => {
    expect(normalizeToolSchema({ oneOf: [{ const: 'a' }, { const: 'b' }] })).toEqual({
      anyOf: [{ enum: ['a'] }, { enum: ['b'] }],
    });
  });

  it('type 数组含 null 时抽成 nullable', () => {
    expect(normalizeToolSchema({ type: ['string', 'null'] })).toEqual({
      type: 'string',
      nullable: true,
    });
  });

  it('递归处理嵌套 properties', () => {
    expect(
      normalizeToolSchema({
        type: 'object',
        properties: { nested: { type: 'object', additionalProperties: true } },
      })
    ).toEqual({
      type: 'object',
      properties: { nested: { type: 'object', properties: {} } },
    });
  });

  it('去掉 propertyNames / dependencies / contains / uniqueItems 等 Google 400 的校验关键字', () => {
    expect(
      normalizeToolSchema({
        type: 'object',
        propertyNames: { pattern: '^[a-z]+$' },
        dependencies: { a: ['b'] },
        dependentRequired: { a: ['b'] },
        dependentSchemas: { a: {} },
        $defs: { x: {} },
        definitions: { x: {} },
        if: {},
        // biome-ignore lint/suspicious/noThenProperty: JSON Schema 条件关键字
        then: {},
        else: {},
        properties: {
          tags: { type: 'array', items: { type: 'string' }, uniqueItems: true, contains: {} },
          n: { type: 'number', multipleOf: 2 },
        },
      })
    ).toEqual({
      type: 'object',
      properties: {
        tags: { type: 'array', items: { type: 'string' } },
        n: { type: 'number' },
      },
    });
  });

  it('非对象输入原样返回', () => {
    expect(normalizeToolSchema(null)).toBe(null);
    expect(normalizeToolSchema('x')).toBe('x');
  });
});

describe('parseUsageWindows', () => {
  const now = Date.parse('2026-01-01T00:00:00Z');

  it('按后端与窗口归并额度，remainingFraction 换算成已用百分比', () => {
    const windows = parseUsageWindows(
      {
        models: {
          'gemini-3.1-pro': {
            modelProvider: 'MODEL_PROVIDER_GOOGLE',
            dailyQuotaInfo: { remainingFraction: 0.25, resetTime: '2026-01-01T06:00:00Z' },
          },
          'claude-opus-4-6': {
            modelProvider: 'MODEL_PROVIDER_ANTHROPIC',
            weeklyQuotaInfo: { remainingFraction: 0.5, resetTime: '2026-01-05T00:00:00Z' },
          },
        },
      },
      now
    );
    expect(windows).toEqual([
      {
        label: 'Anthropic Weekly',
        usedPercent: 50,
        resetsAt: Date.parse('2026-01-05T00:00:00Z'),
      },
      { label: 'Google Daily', usedPercent: 75, resetsAt: Date.parse('2026-01-01T06:00:00Z') },
    ]);
  });

  it('同后端多模型重复上报时取用量最高的那条', () => {
    // 真实场景：耗尽的计数器会省掉 remainingFraction，只留 resetTime
    const windows = parseUsageWindows(
      {
        models: {
          a: {
            modelProvider: 'MODEL_PROVIDER_GOOGLE',
            dailyQuotaInfo: { remainingFraction: 0.9, resetTime: '2026-01-01T06:00:00Z' },
          },
          b: {
            modelProvider: 'MODEL_PROVIDER_GOOGLE',
            dailyQuotaInfo: { resetTime: '2026-01-01T06:00:00Z' },
          },
        },
      },
      now
    );
    expect(windows).toEqual([
      { label: 'Google Daily', usedPercent: 100, resetsAt: Date.parse('2026-01-01T06:00:00Z') },
    ]);
  });

  it('厂商 windowLabel 超长时按共享上限截断', () => {
    const windows = parseUsageWindows(
      {
        models: {
          a: {
            quotaInfo: {
              remainingFraction: 0.5,
              resetTime: '2026-01-01T06:00:00Z',
              windowLabel: 'X'.repeat(200),
            },
          },
        },
      },
      now
    );
    expect(windows).toHaveLength(1);
    expect(windows[0]?.label).toHaveLength(OAUTH_LABEL_MAX_LENGTH);
    expect(windows[0]?.label).toBe('X'.repeat(OAUTH_LABEL_MAX_LENGTH));
  });

  it.each([
    ['null', null],
    ['数组', []],
    ['models 是字符串', { models: 'x' }],
    ['条目是 null', { models: { a: null } }],
    ['配额是数字', { models: { a: { quotaInfo: 5 } } }],
    ['既无 remainingFraction 也无 resetTime', { models: { a: { quotaInfo: {} } } }],
  ])('脏输入 %s 返回空数组而不抛', (_label, payload) => {
    expect(parseUsageWindows(payload, now)).toEqual([]);
  });
});

describe('parseAntigravityManifestVersion', () => {
  it('从 electron-builder manifest 取出版本号', () => {
    expect(parseAntigravityManifestVersion('version: 2.9.1\npath: x.zip')).toBe('2.9.1');
    expect(parseAntigravityManifestVersion('version: "2.9.1" # latest')).toBe('2.9.1');
  });

  it('版本号格式不对或缺失时返回 null', () => {
    expect(parseAntigravityManifestVersion('version: nightly')).toBe(null);
    expect(parseAntigravityManifestVersion('path: x.zip')).toBe(null);
  });
});

describe('antigravityProviderConfig', () => {
  it('provider id 与契约一致', () => {
    expect(ANTIGRAVITY_PROVIDER_ID).toBe('google-antigravity');
  });

  it('注册 streamSimple 时必须同时给 api 与 baseUrl（pi composer 的硬要求）', () => {
    const config = antigravityProviderConfig();
    expect(config.streamSimple).toBeTypeOf('function');
    expect(config.api).toBeTruthy();
    expect(config.baseUrl).toBe('https://daily-cloudcode-pa.googleapis.com');
  });

  it('订阅 oauth 三件套齐全，getApiKey 把 projectId 一起带出去', () => {
    const oauth = antigravityProviderConfig().oauth;
    expect(oauth?.isSubscription).toBe(true);
    expect(oauth?.login).toBeTypeOf('function');
    expect(oauth?.refreshToken).toBeTypeOf('function');
    const serialized = oauth?.getApiKey({
      access: 'tok',
      refresh: 'r',
      expires: 1,
      projectId: 'p-9',
      email: 'a@b.c',
    });
    expect(JSON.parse(serialized ?? '{}')).toMatchObject({ access: 'tok', projectId: 'p-9' });
  });

  it('兜底清单覆盖逻辑表全量，网络不可用时也能选模型', () => {
    const ids = ANTIGRAVITY_FALLBACK_MODELS.map((spec) => spec.id);
    expect(ids).toContain('gemini-3.1-pro');
    expect(ids).toContain('claude-opus-4-6');
    expect(ids).toContain('gemini-2.5-pro');
    expect(ANTIGRAVITY_FALLBACK_MODELS).toHaveLength(ANTIGRAVITY_LOGICAL_MODELS.length);
  });
});

describe('streamSimple（假 fetch，不发真实网络）', () => {
  const model = {
    id: 'gemini-3.1-pro',
    name: 'Gemini 3.1 Pro',
    api: 'google-antigravity-cca',
    provider: ANTIGRAVITY_PROVIDER_ID,
    baseUrl: 'https://daily-cloudcode-pa.googleapis.com',
    reasoning: true,
    input: ['text', 'image'] as ('text' | 'image')[],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1_048_576,
    maxTokens: 65_535,
  };

  const apiKey = JSON.stringify({
    access: 'tok',
    refresh: 'r',
    expires: Date.now() + 600_000,
    projectId: 'projects/p-9',
  });

  function sseResponse(body: string): Response {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        // 故意分两段推，覆盖流式拼接
        const half = Math.floor(body.length / 2);
        controller.enqueue(encoder.encode(body.slice(0, half)));
        controller.enqueue(encoder.encode(body.slice(half)));
        controller.close();
      },
    });
    return new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
  }

  function fakeFetch(body: string): {
    fetch: typeof fetch;
    calls: { url: string; body: string }[];
  } {
    const calls: { url: string; body: string }[] = [];
    const impl = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      // 版本探测走 manifest，返回一条能解析的 yml，避免走真网络
      if (url.includes('manifest')) return new Response('version: 2.8.0\n', { status: 200 });
      calls.push({ url, body: String(init?.body ?? '') });
      return sseResponse(body);
    }) as unknown as typeof fetch;
    return { fetch: impl, calls };
  }

  it('把 Gemini part 翻成 pi 事件序列，工具调用把 stopReason 抬成 toolUse', async () => {
    const sse = [
      'data: {"response":{"candidates":[{"content":{"parts":[{"text":"思考中","thought":true}]}}]}}',
      '',
      'data: {"response":{"candidates":[{"content":{"parts":[{"text":"你好"}]}}]}}',
      '',
      'data: {"response":{"candidates":[{"content":{"parts":[{"functionCall":{"name":"read","args":{"path":"a.ts"},"id":"call_1"}}]}}]}}',
      '',
      'data: {"response":{"candidates":[{"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":120,"cachedContentTokenCount":20,"candidatesTokenCount":30,"thoughtsTokenCount":10,"totalTokenCount":150}}}',
      '',
      '',
    ].join('\n');
    const fake = fakeFetch(sse);

    const stream = antigravityProviderConfig().streamSimple?.(
      model,
      { messages: [] },
      {
        apiKey,
        fetch: fake.fetch,
      }
    );
    if (!stream) throw new Error('streamSimple 未注册');

    const types: string[] = [];
    for await (const event of stream) types.push(event.type);
    const message = await stream.result();

    expect(types).toEqual([
      'start',
      'thinking_start',
      'thinking_delta',
      'thinking_end',
      'text_start',
      'text_delta',
      'text_end',
      'toolcall_start',
      'toolcall_delta',
      'toolcall_end',
      'done',
    ]);
    expect(message.stopReason).toBe('toolUse');
    expect(message.content).toEqual([
      { type: 'thinking', thinking: '思考中' },
      { type: 'text', text: '你好' },
      { type: 'toolCall', id: 'call_1', name: 'read', arguments: { path: 'a.ts' } },
    ]);
    // promptTokenCount 含缓存命中，input 要减掉
    expect(message.usage).toMatchObject({
      input: 100,
      output: 40,
      cacheRead: 20,
      totalTokens: 150,
    });
  });

  it('请求体带上 project / requestType=agent / VALIDATED 工具模式', async () => {
    const fake = fakeFetch(
      'data: {"response":{"candidates":[{"content":{"parts":[{"text":"ok"}]},"finishReason":"STOP"}]}}\n\n'
    );
    const stream = antigravityProviderConfig().streamSimple?.(
      model,
      {
        messages: [{ role: 'user', content: 'hi', timestamp: 0 }],
        tools: [{ name: 'read', description: '读文件', parameters: { type: 'object' } as never }],
      },
      { apiKey, fetch: fake.fetch }
    );
    if (!stream) throw new Error('streamSimple 未注册');
    for await (const _event of stream) void _event;

    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0].url).toBe(
      'https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse'
    );
    const sent = JSON.parse(fake.calls[0].body);
    expect(sent).toMatchObject({
      project: 'projects/p-9',
      // 不给思考档时 gemini-3.1-pro 的 wire id 是 gemini-3.1-pro-low（逻辑 id 后端不认）
      model: 'gemini-3.1-pro-low',
      requestType: 'agent',
      userAgent: 'antigravity',
    });
    expect(sent.request.toolConfig).toEqual({ functionCallingConfig: { mode: 'VALIDATED' } });
    expect(sent.request.tools[0].functionDeclarations[0]).toEqual({
      name: 'read',
      description: '读文件',
      parameters: { type: 'object', properties: {} },
    });
    expect(sent.request.contents).toEqual([{ role: 'user', parts: [{ text: 'hi' }] }]);
    expect(sent.requestId).toMatch(/^agent\/[0-9a-f-]{36}\/\d+\/[0-9a-f-]{36}\/\d+$/);
  });

  it('凭证过期时以 error 事件收尾，不抛到调用方', async () => {
    const fake = fakeFetch('');
    const stream = antigravityProviderConfig().streamSimple?.(
      model,
      { messages: [] },
      {
        apiKey: JSON.stringify({ access: 'tok', refresh: 'r', expires: 1, projectId: 'p' }),
        fetch: fake.fetch,
      }
    );
    if (!stream) throw new Error('streamSimple 未注册');
    const events = await collect(stream);
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('error');
    expect(fake.calls).toHaveLength(0);
  });

  it('主端点 5xx 时倒向 sandbox 端点', async () => {
    const urls: string[] = [];
    const impl = (async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes('manifest')) return new Response('version: 2.8.0\n', { status: 200 });
      urls.push(url);
      if (urls.length === 1) return new Response('boom', { status: 503 });
      return sseResponse(
        'data: {"response":{"candidates":[{"content":{"parts":[{"text":"ok"}]},"finishReason":"STOP"}]}}\n\n'
      );
    }) as unknown as typeof fetch;

    const stream = antigravityProviderConfig().streamSimple?.(
      model,
      { messages: [] },
      {
        apiKey,
        fetch: impl,
      }
    );
    if (!stream) throw new Error('streamSimple 未注册');
    const events = await collect(stream);

    expect(urls).toEqual([
      'https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse',
      'https://daily-cloudcode-pa.sandbox.googleapis.com/v1internal:streamGenerateContent?alt=sse',
    ]);
    expect(events.at(-1)?.type).toBe('done');
  });

  it('流没有 finishReason 就断掉时报错而不是静默完成', async () => {
    const fake = fakeFetch(
      'data: {"response":{"candidates":[{"content":{"parts":[{"text":"半句"}]}}]}}\n\n'
    );
    const stream = antigravityProviderConfig().streamSimple?.(
      model,
      { messages: [] },
      {
        apiKey,
        fetch: fake.fetch,
      }
    );
    if (!stream) throw new Error('streamSimple 未注册');
    const events = await collect(stream);
    expect(events.at(-1)?.type).toBe('error');
  });
});

/**
 * 后端真实模型 id 白名单：用登录账号打 `v1internal:fetchAvailableModels` 拿到的
 * 全部 28 个 id（复跑 `node temp/agy-diag.mjs` 可再核一次）。
 * 这是防止再凭空造 id 的回归网 —— 逻辑表解析出来的 wire id 必须落在这里面，
 * 否则推理时后端回 `404 Requested entity was not found`。
 */
const REAL_BACKEND_MODEL_IDS = [
  'chat_20706',
  'chat_23310',
  'claude-opus-4-6-thinking',
  'claude-sonnet-4-6',
  'gemini-2.5-flash',
  'gemini-2.5-flash-lite',
  'gemini-2.5-flash-thinking',
  'gemini-2.5-pro',
  'gemini-3-flash',
  'gemini-3-flash-agent',
  'gemini-3.1-flash-image',
  'gemini-3.1-flash-lite',
  'gemini-3.1-pro-high',
  'gemini-3.1-pro-low',
  'gemini-3.5-flash-extra-low',
  'gemini-3.5-flash-low',
  'gemini-3.6-flash-high',
  'gemini-3.6-flash-low',
  'gemini-3.6-flash-medium',
  'gemini-3.6-flash-tiered',
  'gemini-3.7-flash-high',
  'gemini-3.7-flash-low',
  'gemini-3.7-flash-medium',
  'gemini-3.7-flash-tiered',
  'gemini-pro-agent',
  'gpt-oss-120b-medium',
  'tab_flash_lite_preview',
  'tab_jump_flash_lite_preview',
];

/**
 * 本地模型表里有、但本账号 tier 一个 wire id 都拿不到的逻辑条目。
 * 不静默从表里删掉（换账号 / 后端上线就会可用），运行时合并按可用性过滤。
 */
const TIER_GAP_MODEL_IDS = ['claude-opus-4-5', 'claude-sonnet-4-5', 'gemini-3-pro'];

const ALL_EFFORTS = [undefined, 'off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;

describe('逻辑 id → wire id 解析', () => {
  it('gemini-3-flash 的 wire id 是 gemini-3.5-flash-extra-low（不是同名裸 id）', () => {
    expect(resolveAntigravityWireModelId('gemini-3-flash')).toBe('gemini-3.5-flash-extra-low');
    expect(resolveAntigravityWireModelId('gemini-3-flash', 'off')).toBe(
      'gemini-3.5-flash-extra-low'
    );
    expect(resolveAntigravityWireModelId('gemini-3-flash', 'low')).toBe(
      'gemini-3.5-flash-extra-low'
    );
    expect(resolveAntigravityWireModelId('gemini-3-flash', 'medium')).toBe('gemini-3.5-flash-low');
    expect(resolveAntigravityWireModelId('gemini-3-flash', 'high')).toBe('gemini-3-flash-agent');
  });

  it('claude-opus-4-5 off 档发裸 id、high 档发 -thinking', () => {
    expect(resolveAntigravityWireModelId('claude-opus-4-5', 'off')).toBe('claude-opus-4-5');
    expect(resolveAntigravityWireModelId('claude-opus-4-5', 'high')).toBe(
      'claude-opus-4-5-thinking'
    );
  });

  it('effortRouting 缺键时逐级降档，缺 off 键时回落 requestModelId', () => {
    // gemini-3.7-flash 只声明到 high；max / xhigh 降到 high
    expect(resolveAntigravityWireModelId('gemini-3.7-flash', 'max')).toBe('gemini-3.7-flash-high');
    expect(resolveAntigravityWireModelId('gemini-3.7-flash', 'xhigh')).toBe(
      'gemini-3.7-flash-high'
    );
    // gemini-3.6-flash 没有 off 键 → requestModelId
    expect(resolveAntigravityWireModelId('gemini-3.6-flash', 'off')).toBe('gemini-3.6-flash-low');
    // 认不出的档位当 off
    expect(resolveAntigravityWireModelId('gemini-3.6-flash', 'bogus')).toBe('gemini-3.6-flash-low');
  });

  it('没有 effortRouting 的条目一律用 requestModelId', () => {
    for (const effort of ALL_EFFORTS) {
      expect(resolveAntigravityWireModelId('claude-opus-4-6', effort)).toBe(
        'claude-opus-4-6-thinking'
      );
      expect(resolveAntigravityWireModelId('gpt-oss-120b', effort)).toBe('gpt-oss-120b-medium');
    }
  });

  it('逻辑表外的 id（运行时发现的裸 wire id）原样返回', () => {
    expect(resolveAntigravityWireModelId('gemini-3.1-pro-high', 'high')).toBe(
      'gemini-3.1-pro-high'
    );
    expect(resolveAntigravityWireModelId('brand-new-model-x')).toBe('brand-new-model-x');
  });

  it('逻辑表里每条的每个档位都解析到后端真实存在的 wire id', () => {
    const gaps: string[] = [];
    for (const logical of ANTIGRAVITY_LOGICAL_MODELS) {
      const wires = new Set(
        ALL_EFFORTS.map((effort) => resolveAntigravityWireModelId(logical.id, effort))
      );
      // 解析结果不能跑出 antigravityWireIds 声明的集合
      expect([...wires].every((wire) => antigravityWireIds(logical).includes(wire))).toBe(true);
      const missing = [...wires].filter((wire) => !REAL_BACKEND_MODEL_IDS.includes(wire));
      if (missing.length === 0) continue;
      // 要么整条都拿不到（tier 差异），要么就是造了 id
      expect(missing).toEqual([...wires]);
      gaps.push(logical.id);
    }
    expect(gaps.sort()).toEqual(TIER_GAP_MODEL_IDS);
  });

  it('逻辑表不含 tab_* / chat_* 补全模型', () => {
    expect(ANTIGRAVITY_LOGICAL_MODELS.some((m) => /^(?:tab|chat)_/.test(m.id))).toBe(false);
  });

  it('兜底清单就是逻辑表全量（暴露的是逻辑 id）', () => {
    expect(ANTIGRAVITY_FALLBACK_MODELS.map((spec) => spec.id)).toEqual(
      ANTIGRAVITY_LOGICAL_MODELS.map((logical) => logical.id)
    );
  });
});

describe('buildRequest 的 model 字段用解析后的 wire id', () => {
  const logicalModel = {
    id: 'gemini-3-flash',
    name: 'Gemini 3 Flash',
    api: 'google-antigravity-cca',
    provider: ANTIGRAVITY_PROVIDER_ID,
    baseUrl: 'https://daily-cloudcode-pa.googleapis.com',
    reasoning: true,
    input: ['text', 'image'] as ('text' | 'image')[],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1_048_576,
    maxTokens: 65_536,
  };

  it('high 档发 gemini-3-flash-agent 而不是逻辑 id', () => {
    const request = buildRequest(logicalModel, { messages: [] }, 'projects/p', {
      reasoning: 'high',
    });
    expect(request.model).toBe('gemini-3-flash-agent');
  });

  it('不给档位时发 requestModelId', () => {
    const request = buildRequest(logicalModel, { messages: [] }, 'projects/p', undefined);
    expect(request.model).toBe('gemini-3.5-flash-extra-low');
  });

  it('maxOutputTokens 按解析后的 wire 模型取上限', () => {
    const claude = {
      ...logicalModel,
      id: 'claude-opus-4-6',
      name: 'Claude Opus 4.6',
      contextWindow: 250_000,
      // 逻辑模型故意给一个比 wire profile 大的值，验证按 wire 取
      maxTokens: 200_000,
    };
    const request = buildRequest(claude, { messages: [] }, 'projects/p', undefined);
    expect(request.model).toBe('claude-opus-4-6-thinking');
    const generationConfig = request.request.generationConfig as { maxOutputTokens: number };
    expect(generationConfig.maxOutputTokens).toBe(
      ANTIGRAVITY_WIRE_MAX_OUTPUT_TOKENS['claude-opus-4-6-thinking']
    );
  });

  it('没有 wire profile 的 wire id 沿用逻辑模型上限', () => {
    const flashLite = { ...logicalModel, id: 'gemini-3.1-flash-lite', maxTokens: 65_535 };
    const request = buildRequest(flashLite, { messages: [] }, 'projects/p', undefined);
    expect(request.model).toBe('gemini-3.1-flash-lite');
    expect(ANTIGRAVITY_WIRE_MAX_OUTPUT_TOKENS['gemini-3.1-flash-lite']).toBeUndefined();
    const generationConfig = request.request.generationConfig as { maxOutputTokens: number };
    expect(generationConfig.maxOutputTokens).toBe(65_535);
  });
});

describe('mergeAntigravityModels', () => {
  it('已归属的 wire id 不重复暴露，陌生 id 独立暴露，tier 拿不到的不暴露', () => {
    const discovered = parseAvailableModels({
      models: {
        'gemini-3.5-flash-extra-low': { displayName: 'Gemini 3.5 Flash (Low)' },
        'gemini-3-flash': { displayName: 'Gemini 3 Flash' },
        'gemini-3.6-flash-tiered': {},
        'brand-new-model-x': { displayName: 'Brand New' },
        tab_flash_lite_preview: {},
      },
    });
    const ids = mergeAntigravityModels(discovered).map((spec) => spec.id);

    // extra-low 同时是 gemini-3-flash 与 gemini-3.5-flash 的 wire id → 两条逻辑模型都可用
    expect(ids).toContain('gemini-3-flash');
    expect(ids).toContain('gemini-3.5-flash');
    // 已归属的 wire id 不单独出现，逻辑 id 也只出现一次
    expect(ids).not.toContain('gemini-3.5-flash-extra-low');
    expect(ids.filter((id) => id === 'gemini-3-flash')).toHaveLength(1);
    // 归不到逻辑表的后端 id 独立暴露
    expect(ids).toContain('brand-new-model-x');
    expect(ids).toContain('gemini-3.6-flash-tiered');
    // 后端没返回 wire id 的逻辑条目不暴露
    expect(ids).not.toContain('gemini-2.5-pro');
    expect(ids).not.toContain('claude-opus-4-5');
    expect(ids).not.toContain('gemini-3.6-flash');
    // 补全模型仍被过滤
    expect(ids).not.toContain('tab_flash_lite_preview');
  });

  it('喂进后端真实的 28 个 id 时得到逻辑表可用项 + 未归属的新 id', () => {
    const models: Record<string, unknown> = {};
    for (const id of REAL_BACKEND_MODEL_IDS) models[id] = {};
    const ids = mergeAntigravityModels(parseAvailableModels({ models })).map((spec) => spec.id);

    expect(ids.sort()).toEqual(
      [
        // 逻辑条目（本账号可用的 14 条）
        'claude-opus-4-6',
        'claude-sonnet-4-6',
        'gemini-2.5-flash',
        'gemini-2.5-flash-lite',
        'gemini-2.5-pro',
        'gemini-3-flash',
        'gemini-3.1-flash-image',
        'gemini-3.1-flash-lite',
        'gemini-3.1-pro',
        'gemini-3.5-flash',
        'gemini-3.6-flash',
        'gemini-3.7-flash',
        'gemini-3.7-flash-tiered',
        'gpt-oss-120b',
        // 后端有、本地模型表没单独归属的：3.1-pro 的 high 走 gemini-pro-agent，
        // 所以 gemini-3.1-pro-high 是一条独立可选模型
        'gemini-3.1-pro-high',
        'gemini-3.6-flash-tiered',
      ].sort()
    );
    for (const gap of TIER_GAP_MODEL_IDS) expect(ids).not.toContain(gap);
  });

  it('后端一条都没返回时合并结果为空（调用方回落兜底表）', () => {
    expect(mergeAntigravityModels([])).toEqual([]);
  });
});

describe('sanitizeUpstreamBody（上游响应体进 Error.message 前脱敏 + 截断）', () => {
  it('截到 300 字并标注已截断', () => {
    const safe = sanitizeUpstreamBody('x'.repeat(5_000));
    expect(safe).toBe(`${'x'.repeat(300)}…（已截断）`);
  });

  it('短响应体原样保留（只压空白）', () => {
    expect(sanitizeUpstreamBody('{"error":{"code":404,\n  "message":"not found"}}')).toBe(
      '{"error":{"code":404, "message":"not found"}}'
    );
  });

  it('抹掉 Authorization 头回显', () => {
    const safe = sanitizeUpstreamBody('proxy denied: Authorization: Bearer ya29.AbCdEf-1234_x');
    expect(safe).not.toContain('ya29.AbCdEf');
    expect(safe).toContain('[已脱敏]');
  });

  it('抹掉 token 字段（JSON 与表单两种形态），保留字段名便于排障', () => {
    const json = sanitizeUpstreamBody(
      '{"access_token":"ya29.secret","refresh_token":"1//0gSecret","expires_in":3599}'
    );
    expect(json).not.toContain('ya29.secret');
    expect(json).not.toContain('1//0gSecret');
    expect(json).toContain('"access_token": "[已脱敏]"');
    expect(json).toContain('expires_in');

    const form = sanitizeUpstreamBody('grant_type=refresh_token&client_secret=GOCSPX-abcdef');
    expect(form).not.toContain('GOCSPX-abcdef');
    expect(form).toContain('client_secret=[已脱敏]');
  });

  it('抹掉裸 JWT', () => {
    const safe = sanitizeUpstreamBody(
      'id_token was eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiIxIn0.sIgNaTuRe'
    );
    expect(safe).not.toContain('eyJhbGciOiJSUzI1NiJ9');
    expect(safe).toContain('[已脱敏]');
  });

  it('先脱敏后截断，token 不会因为切在中间而漏出前半截', () => {
    const token = `ya29.${'A'.repeat(400)}`;
    const safe = sanitizeUpstreamBody(`HTTP 401 Bearer ${token}`);
    expect(safe).not.toContain('AAAA');
  });
});

describe('OAuth loopback 回调服务器', () => {
  it('非法回调只返回 400，随后合法回调仍能完成登录', async () => {
    const server = await startOauthCallbackServer({
      preferredPort: 0,
      callbackPath: '/oauth-callback',
      expectedState: 'expected-state',
      timeoutMs: 2_000,
    });
    const result = server.waitForCode().then(
      (code) => ({ code }),
      (error: Error) => ({ error })
    );

    try {
      const mismatched = await fetch(`${server.redirectUri}?code=bad&state=wrong-state`);
      const missingCode = await fetch(`${server.redirectUri}?state=expected-state`);
      expect(mismatched.status).toBe(400);
      expect(missingCode.status).toBe(400);

      const valid = await fetch(`${server.redirectUri}?code=good&state=expected-state`);
      expect(valid.status).toBe(200);
      await expect(result).resolves.toEqual({ code: 'good' });
    } finally {
      server.close();
    }
  });

  it('用户显式拒绝授权时结束等待并返回可读错误', async () => {
    const server = await startOauthCallbackServer({
      preferredPort: 0,
      callbackPath: '/oauth-callback',
      expectedState: 'expected-state',
      timeoutMs: 2_000,
    });
    const result = server.waitForCode().then(
      () => 'resolved',
      (error: Error) => error.message
    );

    try {
      const response = await fetch(
        `${server.redirectUri}?error=access_denied&state=expected-state`
      );
      expect(response.status).toBe(400);
      await expect(result).resolves.toBe('授权被拒绝：access_denied');
    } finally {
      server.close();
    }
  });

  it('关闭服务器会立即结束等待，不会挂到超时', async () => {
    const server = await startOauthCallbackServer({
      preferredPort: 0,
      callbackPath: '/oauth-callback',
      expectedState: 'expected-state',
      timeoutMs: 2_000,
    });
    let outcome = '仍在等待';
    void server.waitForCode().then(
      () => {
        outcome = 'resolved';
      },
      (error: Error) => {
        outcome = error.message;
      }
    );

    server.close();
    await Promise.resolve();
    expect(outcome).toBe('回调服务器已关闭');
  });
});

describe('Antigravity 请求信封会话隔离', () => {
  const model = {
    id: 'gemini-3.1-pro',
    name: 'Gemini 3.1 Pro',
    api: 'google-antigravity-cca',
    provider: ANTIGRAVITY_PROVIDER_ID,
    baseUrl: 'https://daily-cloudcode-pa.googleapis.com',
    reasoning: true,
    input: ['text'] as ('text' | 'image')[],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1_048_576,
    maxTokens: 65_535,
  };
  const envelope = (sessionId?: string) =>
    buildRequest(model, { messages: [] }, 'projects/test', {
      sessionId,
    });

  it('缺 sessionId 的请求各用一次性信封，不共享会话状态', () => {
    const first = envelope();
    const second = envelope();

    expect(second.request.sessionId).not.toBe(first.request.sessionId);
    expect(second.requestId.split('/')[1]).not.toBe(first.requestId.split('/')[1]);
  });

  it('LRU 驱逐保留刚使用过的活跃会话', () => {
    const prefix = `lru-${crypto.randomUUID()}`;
    const hotSession = `${prefix}-hot`;
    const first = envelope(hotSession);
    for (let i = 0; i < 63; i++) envelope(`${prefix}-filler-${i}`);

    const touched = envelope(hotSession);
    envelope(`${prefix}-overflow`);
    const afterEviction = envelope(hotSession);

    expect(afterEviction.request.sessionId).toBe(first.request.sessionId);
    expect(afterEviction.requestId.split('/')[1]).toBe(first.requestId.split('/')[1]);
    expect(afterEviction.requestId.split('/')[3]).toBe(first.requestId.split('/')[3]);
    expect(Number(afterEviction.requestId.split('/')[4])).toBe(
      Number(touched.requestId.split('/')[4]) + 1
    );
  });
});

describe('本地 AssistantMessageEventStream', () => {
  it('只 push(done) 不调用 end 时 result() 也会立即兑现', async () => {
    const stream = createEventStream();
    const message = {
      role: 'assistant' as const,
      content: [],
      api: 'google-antigravity-cca',
      provider: ANTIGRAVITY_PROVIDER_ID,
      model: 'gemini-3.1-pro',
      usage: emptyUsage(),
      stopReason: 'stop' as const,
      timestamp: 0,
    };

    let outcome: PiAssistantMessage | undefined;
    void stream.result().then((result) => {
      outcome = result;
    });
    stream.push({ type: 'done', reason: 'stop', message });
    await Promise.resolve();
    expect(outcome).toBe(message);
  });
});

describe('refreshModels 与 pi 刷新契约', () => {
  // pi 每次 registerProvider 都会以 allowNetwork:false 重跑 refreshModels 并原样发布返回值
  // （provider-composer.js），返回兜底表会把此前联网发现的清单冲掉
  const credential = { type: 'oauth', access: 'tok', refresh: 'r', expires: Date.now() + 1e6 };
  const backend = {
    models: {
      'gemini-3.8-flash-tiered': { displayName: 'Gemini 3.8 Flash Tiered' },
      'gemini-3.1-pro-low': { displayName: 'Gemini 3.1 Pro (Low)' },
    },
  };
  const refresh = (allowNetwork: boolean) =>
    antigravityProviderConfig().refreshModels?.({
      credential,
      allowNetwork,
      signal: new AbortController().signal,
      stored: undefined,
      publish: async () => true,
    } as never);

  afterEach(() => vi.unstubAllGlobals());

  it('离线重跑时保留最近一次联网发现的清单，而不是退回兜底表', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL | Request) =>
        String(url).includes('fetchAvailableModels')
          ? new Response(JSON.stringify(backend), { status: 200 })
          : new Response('', { status: 404 })
      )
    );
    const online = await refresh(true);
    expect(online?.map((m) => m.id)).toContain('gemini-3.8-flash-tiered');

    const offline = await refresh(false);
    expect(offline?.map((m) => m.id)).toContain('gemini-3.8-flash-tiered');
    expect(offline).toEqual(online);
  });
});
