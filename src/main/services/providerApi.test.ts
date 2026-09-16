import { MOCK_API_KEY, MOCK_BASE_URL, MOCK_CHAT_MODEL_ID } from '@shared/mockProvider';
import { withVersionSegment } from '@shared/providerCatalog';
import type { ModelApiKind } from '@shared/types';
import { net } from 'electron';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  extractModelEntries,
  isOfficialAnthropicHost,
  isValidModelListPayload,
  listModels,
  resolveBase,
  testProvider,
  toMessage,
} from './providerApi';

const proxyMocks = vi.hoisted(() => ({
  whenReady: vi.fn(async () => true),
}));

vi.mock('./proxyConfig', () => ({
  getProxyConfig: () => ({ whenReady: proxyMocks.whenReady }),
}));

const originalNetFetch = net.fetch;

function mockResponse(status: number, body?: unknown, statusText = 'OK'): Response {
  return new Response(body !== undefined ? JSON.stringify(body) : null, {
    status,
    statusText,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : {},
  });
}

describe('isOfficialAnthropicHost', () => {
  it('识别官方 api.anthropic.com，不论是否有协议或路径', () => {
    expect(isOfficialAnthropicHost('https://api.anthropic.com')).toBe(true);
    expect(isOfficialAnthropicHost('https://api.anthropic.com/v1')).toBe(true);
    expect(isOfficialAnthropicHost('http://api.anthropic.com/v1/models')).toBe(true);
  });

  it('不误判相似域名或第三方域名', () => {
    expect(isOfficialAnthropicHost('https://not-anthropic.com')).toBe(false);
    expect(isOfficialAnthropicHost('https://api.anthropic.com.evil.com')).toBe(false);
    expect(isOfficialAnthropicHost('https://anthropic.com')).toBe(false);
    expect(isOfficialAnthropicHost('https://api.anyrouter.top')).toBe(false);
  });

  it('非法或空 URL 安全返回 false', () => {
    expect(isOfficialAnthropicHost('')).toBe(false);
    expect(isOfficialAnthropicHost('not-a-url')).toBe(false);
  });
});

describe('resolveBase', () => {
  const cfg = (baseUrl: string, api: ModelApiKind = 'openai-completions') => ({
    api,
    apiKey: 'k',
    baseUrl,
  });

  it('留空时回退到该协议的官方地址', () => {
    expect(resolveBase(cfg(''))).toBe('https://api.openai.com/v1');
    expect(resolveBase(cfg('  ', 'anthropic-messages'))).toBe('https://api.anthropic.com');
    expect(resolveBase(cfg('', 'google-generative-ai'))).toBe(
      'https://generativelanguage.googleapis.com/v1beta'
    );
    expect(resolveBase(cfg('', 'ollama'))).toBe('http://127.0.0.1:11434');
  });

  it('去掉末尾斜杠', () => {
    expect(resolveBase(cfg('https://example.com/v1/'))).toBe('https://example.com/v1');
    expect(resolveBase(cfg('https://example.com///'))).toBe('https://example.com');
  });

  it('去掉首尾空白', () => {
    expect(resolveBase(cfg('  https://example.com  '))).toBe('https://example.com');
  });
});

describe('mock provider 短路', () => {
  afterEach(() => {
    net.fetch = originalNetFetch;
  });

  it('list/test 不走网络，返回内置模型', async () => {
    const fetchMock = vi.fn();
    net.fetch = fetchMock;
    const config = {
      api: 'openai-completions' as const,
      apiKey: MOCK_API_KEY,
      baseUrl: MOCK_BASE_URL,
    };
    await expect(listModels(config)).resolves.toMatchObject({
      ok: true,
      models: expect.arrayContaining([{ id: MOCK_CHAT_MODEL_ID }]),
    });
    await expect(testProvider(config, MOCK_CHAT_MODEL_ID)).resolves.toMatchObject({
      ok: true,
      message: MOCK_CHAT_MODEL_ID,
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(proxyMocks.whenReady).not.toHaveBeenCalled();
  });
});

describe('withVersionSegment', () => {
  it('缺少版本段时补上', () => {
    expect(withVersionSegment('https://api.anthropic.com', 'v1')).toBe(
      'https://api.anthropic.com/v1'
    );
  });

  it('已有版本段时不重复拼接', () => {
    // 用户填的 baseUrl 常常已经带了 /v1
    expect(withVersionSegment('https://example.com/v1', 'v1')).toBe('https://example.com/v1');
    expect(withVersionSegment('https://example.com/v1beta', 'v1beta')).toBe(
      'https://example.com/v1beta'
    );
  });

  it('只认结尾的完整段，不会被子串骗过', () => {
    // v1beta 结尾不应被当作已含 v1
    expect(withVersionSegment('https://example.com/v1beta', 'v1')).toBe(
      'https://example.com/v1beta/v1'
    );
  });
});

describe('isValidModelListPayload', () => {
  it('Anthropic / OpenAI 要求根对象包含 data 数组', () => {
    expect(isValidModelListPayload('anthropic-messages', { data: [] })).toBe(true);
    expect(isValidModelListPayload('openai-completions', { data: [{ id: 'm1' }] })).toBe(true);
    expect(isValidModelListPayload('openai-responses', { data: [] })).toBe(true);
    expect(isValidModelListPayload('anthropic-messages', { data: 'not-array' })).toBe(false);
    expect(isValidModelListPayload('anthropic-messages', {})).toBe(false);
    expect(isValidModelListPayload('anthropic-messages', null)).toBe(false);
    expect(isValidModelListPayload('anthropic-messages', [])).toBe(false);
  });

  it('Google / Ollama 要求根对象包含 models 数组', () => {
    expect(isValidModelListPayload('google-generative-ai', { models: [] })).toBe(true);
    expect(isValidModelListPayload('ollama', { models: [] })).toBe(true);
    expect(isValidModelListPayload('google-generative-ai', { data: [] })).toBe(false);
    expect(isValidModelListPayload('ollama', { models: null })).toBe(false);
    expect(isValidModelListPayload('google-generative-ai', 'string')).toBe(false);
  });
});

describe('extractModelEntries', () => {
  it('OpenAI 兼容：取 data[].id', () => {
    const data = { data: [{ id: 'gpt-5' }, { id: 'gpt-4o' }] };
    expect(extractModelEntries('openai-completions', data)).toEqual([
      { id: 'gpt-5' },
      { id: 'gpt-4o' },
    ]);
    expect(extractModelEntries('anthropic-messages', data)).toEqual([
      { id: 'gpt-5' },
      { id: 'gpt-4o' },
    ]);
  });

  it('Gemini：取 models[].name 并剥掉 models/ 前缀', () => {
    const data = { models: [{ name: 'models/gemini-2.0-flash' }, { name: 'models/gemini-pro' }] };
    expect(extractModelEntries('google-generative-ai', data)).toEqual([
      { id: 'gemini-2.0-flash' },
      { id: 'gemini-pro' },
    ]);
  });

  it('Ollama：优先 model 字段，回退 name', () => {
    const data = { models: [{ model: 'llama3:8b', name: 'llama3' }, { name: 'qwen' }] };
    expect(extractModelEntries('ollama', data)).toEqual([{ id: 'llama3:8b' }, { id: 'qwen' }]);
  });

  it('响应结构不符时返回空数组而不是抛错', () => {
    expect(extractModelEntries('openai-completions', {})).toEqual([]);
    expect(extractModelEntries('openai-completions', { data: 'not-an-array' })).toEqual([]);
    expect(extractModelEntries('ollama', { models: null })).toEqual([]);
    expect(extractModelEntries('google-generative-ai', {})).toEqual([]);
  });

  it('过滤掉 id 缺失或类型不对的条目', () => {
    const data = { data: [{ id: 'ok' }, { id: 123 }, {}, null] };
    expect(extractModelEntries('openai-completions', data)).toEqual([{ id: 'ok' }]);
  });

  it('OpenAI 兼容：识别 context_length 与 max_tokens 类扩展字段', () => {
    const data = {
      data: [
        { id: 'grok-4.6', context_length: 256000 },
        { id: 'a', contextLength: 100, max_output_tokens: 50 },
        { id: 'b', input_token_limit: 200, output_token_limit: 60 },
        { id: 'c', max_input_tokens: 300, max_tokens: 70 },
        { id: 'd', context_window: 400, max_completion_tokens: 80 },
        { id: 'e', context_size: 500 },
      ],
    };
    expect(extractModelEntries('openai-completions', data)).toEqual([
      { id: 'grok-4.6', contextWindow: 256000 },
      { id: 'a', contextWindow: 100, maxTokens: 50 },
      { id: 'b', contextWindow: 200, maxTokens: 60 },
      { id: 'c', contextWindow: 300, maxTokens: 70 },
      { id: 'd', contextWindow: 400, maxTokens: 80 },
      { id: 'e', contextWindow: 500 },
    ]);
  });

  it('OpenRouter 形状：top_provider.max_completion_tokens', () => {
    const data = {
      data: [
        { id: 'or-model', context_length: 131072, top_provider: { max_completion_tokens: 4096 } },
      ],
    };
    expect(extractModelEntries('openai-completions', data)).toEqual([
      { id: 'or-model', contextWindow: 131072, maxTokens: 4096 },
    ]);
  });

  it('字段优先级：更具体的字段名先命中', () => {
    const data = {
      data: [
        {
          id: 'multi',
          context_length: 1000,
          context_window: 2000,
          max_completion_tokens: 100,
          max_tokens: 999,
        },
      ],
    };
    expect(extractModelEntries('openai-completions', data)).toEqual([
      { id: 'multi', contextWindow: 1000, maxTokens: 100 },
    ]);
  });

  it('Gemini：识别官方 inputTokenLimit / outputTokenLimit', () => {
    const data = {
      models: [
        { name: 'models/gemini-2.0-flash', inputTokenLimit: 1048576, outputTokenLimit: 8192 },
      ],
    };
    expect(extractModelEntries('google-generative-ai', data)).toEqual([
      { id: 'gemini-2.0-flash', contextWindow: 1048576, maxTokens: 8192 },
    ]);
  });

  it('非正 / 非有限 / 非数字的元数据一律丢弃，只留 id', () => {
    const data = {
      data: [
        { id: 'zero', context_length: 0 },
        { id: 'neg', context_length: -5, max_tokens: -1 },
        { id: 'nan', context_length: Number.NaN, max_tokens: Number.POSITIVE_INFINITY },
        { id: 'str', context_length: '128000', max_tokens: '4096' },
      ],
    };
    expect(extractModelEntries('openai-completions', data)).toEqual([
      { id: 'zero' },
      { id: 'neg' },
      { id: 'nan' },
      { id: 'str' },
    ]);
  });
});

describe('toMessage', () => {
  it('超时被翻译成可读文案', () => {
    const err = new Error('aborted');
    err.name = 'AbortError';
    expect(toMessage(err)).toBe('Request timed out');
  });

  it('普通 Error 取 message', () => {
    expect(toMessage(new Error('connect ECONNREFUSED'))).toBe('connect ECONNREFUSED');
  });

  it('非 Error 值转成字符串', () => {
    expect(toMessage('boom')).toBe('boom');
    expect(toMessage(42)).toBe('42');
  });
});

describe('远端错误边界', () => {
  it('list/test 都只返回状态，不读取或回显恶意响应 body', async () => {
    const secret = 'sk-provider-real-secret';
    const text = vi.fn(async () => `malicious body ${secret}`);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: false,
        status: 401,
        statusText: 'Unauthorized',
        text,
      }))
    );
    const config = {
      api: 'openai-completions' as const,
      apiKey: secret,
      baseUrl: 'https://example.test/v1',
    };

    await expect(listModels(config)).resolves.toEqual({
      ok: false,
      models: [],
      error: 'HTTP 401 Unauthorized',
    });
    await expect(testProvider(config, 'model-1')).resolves.toMatchObject({
      ok: false,
      message: 'HTTP 401 Unauthorized',
    });
    expect(text).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it('fetch抛错即使回显真实key也按值脱敏', async () => {
    const secret = 'sk-provider-throw-secret';
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error(`request failed https://example.test/models?key=${secret}`);
      })
    );
    const config = {
      api: 'openai-completions' as const,
      apiKey: secret,
      baseUrl: 'https://example.test/v1',
    };

    const listed = await listModels(config);
    const tested = await testProvider(config, 'model-1');
    expect(JSON.stringify([listed, tested])).not.toContain(secret);
    expect(JSON.stringify([listed, tested])).toContain('[redacted]');
    vi.unstubAllGlobals();
  });

  it('listModels 响应必须是对象且符合各协议要求的根数组，坏 JSON / HTML / 错误结构返回失败', async () => {
    // 坏 JSON (如 HTML 页面或截断文本)
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => {
          throw new Error('Unexpected token < in JSON at position 0');
        },
      }))
    );
    const cfg = {
      api: 'anthropic-messages' as const,
      apiKey: 'k',
      baseUrl: 'https://anyrouter.top',
    };
    const htmlRes = await listModels(cfg);
    expect(htmlRes.ok).toBe(false);
    expect(htmlRes.models).toEqual([]);
    expect(htmlRes.error).toBe('Unexpected token < in JSON at position 0');

    // 200 但顶层不是要求的数组 (如错误结构 { error: 'something' })
    vi.unstubAllGlobals();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => ({ error: 'something went wrong' }),
      }))
    );
    const structRes = await listModels(cfg);
    expect(structRes.ok).toBe(false);
    expect(structRes.models).toEqual([]);
    expect(structRes.error).toBe('Invalid model list response format');

    // 合法空数组返回 ok: true
    vi.unstubAllGlobals();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => ({ data: [] }),
      }))
    );
    const emptyRes = await listModels(cfg);
    expect(emptyRes.ok).toBe(true);
    expect(emptyRes.models).toEqual([]);

    vi.unstubAllGlobals();
  });
});

describe('listModels 集成行为与鉴权兼容', () => {
  afterEach(() => {
    net.fetch = originalNetFetch;
    vi.unstubAllGlobals();
  });

  it('第三方 Anthropic 首次 401 时以 Bearer 重试一次同一 URL，成功解析模型', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(mockResponse(401, undefined, 'Unauthorized'))
      .mockResolvedValueOnce(mockResponse(200, { data: [{ id: 'claude-3-7-sonnet' }] }));
    net.fetch = fetchMock;

    const config = {
      api: 'anthropic-messages' as const,
      apiKey: 'sk-ant-thirdparty',
      baseUrl: 'https://api.anyrouter.top',
    };

    const res = await listModels(config);
    expect(res.ok).toBe(true);
    expect(res.models).toEqual([{ id: 'claude-3-7-sonnet' }]);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    const [firstCallUrl, firstCallInit] = fetchMock.mock.calls[0];
    const [secondCallUrl, secondCallInit] = fetchMock.mock.calls[1];

    expect(firstCallUrl).toBe('https://api.anyrouter.top/v1/models');
    expect(secondCallUrl).toBe('https://api.anyrouter.top/v1/models');

    expect(firstCallInit.headers).toEqual({
      'x-api-key': 'sk-ant-thirdparty',
      'anthropic-version': '2023-06-01',
    });
    expect(secondCallInit.headers).toEqual({
      Authorization: 'Bearer sk-ant-thirdparty',
      'anthropic-version': '2023-06-01',
    });
    expect(secondCallInit.headers['x-api-key']).toBeUndefined();
  });

  it('相似官方域名（如 api.anthropic.com.evil.com）不误判为官方，401 时仍以 Bearer 重试', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(mockResponse(401, undefined, 'Unauthorized'))
      .mockResolvedValueOnce(mockResponse(200, { data: [{ id: 'custom-claude' }] }));
    net.fetch = fetchMock;

    const res = await listModels({
      api: 'anthropic-messages',
      apiKey: 'k',
      baseUrl: 'https://api.anthropic.com.evil.com',
    });
    expect(res.ok).toBe(true);
    expect(res.models).toEqual([{ id: 'custom-claude' }]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('官方 Anthropic（包括默认空 baseUrl 与带 /v1 地址）401 一次结束，绝不重试 Bearer', async () => {
    const fetchMock = vi.fn().mockResolvedValue(mockResponse(401, undefined, 'Unauthorized'));
    net.fetch = fetchMock;

    // 1. 默认空 baseUrl
    const resDefault = await listModels({
      api: 'anthropic-messages',
      apiKey: 'k',
      baseUrl: '',
    });
    expect(resDefault.ok).toBe(false);
    expect(resDefault.error).toBe('HTTP 401 Unauthorized');
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // 2. 显式官方 baseUrl
    fetchMock.mockClear();
    const resExplicit = await listModels({
      api: 'anthropic-messages',
      apiKey: 'k',
      baseUrl: 'https://api.anthropic.com',
    });
    expect(resExplicit.ok).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // 3. 官方带 /v1
    fetchMock.mockClear();
    const resWithV1 = await listModels({
      api: 'anthropic-messages',
      apiKey: 'k',
      baseUrl: 'https://api.anthropic.com/v1',
    });
    expect(resWithV1.ok).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('第三方 Anthropic 首次 401 第二次仍 401，恰好两次结束，不发第三次', async () => {
    const fetchMock = vi.fn().mockResolvedValue(mockResponse(401, undefined, 'Unauthorized'));
    net.fetch = fetchMock;

    const res = await listModels({
      api: 'anthropic-messages',
      apiKey: 'k',
      baseUrl: 'https://api.anyrouter.top',
    });
    expect(res.ok).toBe(false);
    expect(res.error).toBe('HTTP 401 Unauthorized');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it.each([
    {
      name: '403 Forbidden',
      mock: () => Promise.resolve(mockResponse(403, undefined, 'Forbidden')),
    },
    {
      name: '429 Too Many Requests',
      mock: () => Promise.resolve(mockResponse(429, undefined, 'Too Many Requests')),
    },
    {
      name: '500 Internal Server Error',
      mock: () => Promise.resolve(mockResponse(500, undefined, 'Internal Server Error')),
    },
    {
      name: 'AbortError (timeout)',
      mock: () => {
        const err = new Error('aborted');
        err.name = 'AbortError';
        return Promise.reject(err);
      },
    },
    { name: 'Network Error', mock: () => Promise.reject(new Error('connect ECONNREFUSED')) },
  ])('第三方 Anthropic 遇到 $name 不进行重试，只请求一次', async ({ mock }) => {
    const fetchMock = vi.fn(mock);
    net.fetch = fetchMock;

    const res = await listModels({
      api: 'anthropic-messages',
      apiKey: 'k',
      baseUrl: 'https://api.anyrouter.top',
    });
    expect(res.ok).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('第三方 Anthropic 401 回退 Bearer 后若返回坏 JSON 或错误结构，返回失败', async () => {
    // 401 -> 200 坏 JSON (如 HTML)
    const badJsonMock = vi
      .fn()
      .mockResolvedValueOnce(mockResponse(401, undefined, 'Unauthorized'))
      .mockResolvedValueOnce(
        new Response('<html>Bad Gateway</html>', {
          status: 200,
          statusText: 'OK',
          headers: { 'Content-Type': 'text/html' },
        })
      );
    net.fetch = badJsonMock;

    const resBadJson = await listModels({
      api: 'anthropic-messages',
      apiKey: 'k',
      baseUrl: 'https://api.anyrouter.top',
    });
    expect(resBadJson.ok).toBe(false);
    expect(resBadJson.error).toContain('Unexpected token');
    expect(badJsonMock).toHaveBeenCalledTimes(2);

    // 401 -> 200 错误结构 (缺少 data 数组)
    const badStructMock = vi
      .fn()
      .mockResolvedValueOnce(mockResponse(401, undefined, 'Unauthorized'))
      .mockResolvedValueOnce(mockResponse(200, { error: { message: 'Invalid payload' } }));
    net.fetch = badStructMock;

    const resBadStruct = await listModels({
      api: 'anthropic-messages',
      apiKey: 'k',
      baseUrl: 'https://api.anyrouter.top',
    });
    expect(resBadStruct.ok).toBe(false);
    expect(resBadStruct.error).toBe('Invalid model list response format');
    expect(badStructMock).toHaveBeenCalledTimes(2);
  });

  it('Google 与 Ollama 协议：合法空 models 数组与正常 models 均能正确解析', async () => {
    // Google: 空 models 与正常 models
    const googleMock = vi
      .fn()
      .mockResolvedValueOnce(mockResponse(200, { models: [] }))
      .mockResolvedValueOnce(
        mockResponse(200, {
          models: [{ name: 'models/gemini-2.0-flash', inputTokenLimit: 1048576 }],
        })
      );
    net.fetch = googleMock;

    const googleEmpty = await listModels({
      api: 'google-generative-ai',
      apiKey: 'k',
      baseUrl: 'https://generativelanguage.googleapis.com',
    });
    expect(googleEmpty.ok).toBe(true);
    expect(googleEmpty.models).toEqual([]);

    const googleModels = await listModels({
      api: 'google-generative-ai',
      apiKey: 'k',
      baseUrl: 'https://generativelanguage.googleapis.com',
    });
    expect(googleModels.ok).toBe(true);
    expect(googleModels.models).toEqual([{ id: 'gemini-2.0-flash', contextWindow: 1048576 }]);

    // Ollama: 空 models 与正常 models
    const ollamaMock = vi
      .fn()
      .mockResolvedValueOnce(mockResponse(200, { models: [] }))
      .mockResolvedValueOnce(mockResponse(200, { models: [{ name: 'llama3:8b' }] }));
    net.fetch = ollamaMock;

    const ollamaEmpty = await listModels({
      api: 'ollama',
      apiKey: '',
      baseUrl: 'http://127.0.0.1:11434',
    });
    expect(ollamaEmpty.ok).toBe(true);
    expect(ollamaEmpty.models).toEqual([]);

    const ollamaModels = await listModels({
      api: 'ollama',
      apiKey: '',
      baseUrl: 'http://127.0.0.1:11434',
    });
    expect(ollamaModels.ok).toBe(true);
    expect(ollamaModels.models).toEqual([{ id: 'llama3:8b' }]);
  });

  it('其他协议（如 OpenAI）遇 401 不新增鉴权回退', async () => {
    const fetchMock = vi.fn().mockResolvedValue(mockResponse(401, undefined, 'Unauthorized'));
    net.fetch = fetchMock;

    const res = await listModels({
      api: 'openai-completions',
      apiKey: 'k',
      baseUrl: 'https://api.openai.com/v1',
    });
    expect(res.ok).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('listModels 所有协议的标准请求及第三方回退均指定 redirect: manual，遇 3xx 返回失败而不泄漏凭据', async () => {
    const fetchMock = vi.fn().mockResolvedValue(mockResponse(302, undefined, 'Found'));
    net.fetch = fetchMock;

    // 1. Anthropic listModels 标准请求
    const resAnthropic = await listModels({
      api: 'anthropic-messages',
      apiKey: 'k',
      baseUrl: 'https://api.anyrouter.top',
    });
    expect(resAnthropic.ok).toBe(false);
    expect(resAnthropic.error).toBe('HTTP 302 Found');
    expect(fetchMock.mock.calls[0][1].redirect).toBe('manual');

    // 2. OpenAI listModels 标准请求
    fetchMock.mockClear();
    await listModels({
      api: 'openai-completions',
      apiKey: 'k',
      baseUrl: 'https://api.openai.com/v1',
    });
    expect(fetchMock.mock.calls[0][1].redirect).toBe('manual');

    // 3. Anthropic 401 后 Bearer 回退请求也必须是 redirect: manual
    fetchMock.mockReset();
    fetchMock
      .mockResolvedValueOnce(mockResponse(401, undefined, 'Unauthorized'))
      .mockResolvedValueOnce(mockResponse(307, undefined, 'Temporary Redirect'));

    const resFallbackRedirect = await listModels({
      api: 'anthropic-messages',
      apiKey: 'k',
      baseUrl: 'https://api.anyrouter.top',
    });
    expect(resFallbackRedirect.ok).toBe(false);
    expect(resFallbackRedirect.error).toBe('HTTP 307 Temporary Redirect');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1][1].redirect).toBe('manual');
  });
});

function requestBody(fetchMock: ReturnType<typeof vi.fn>): Record<string, unknown> {
  const init = fetchMock.mock.calls[0]?.[1] as RequestInit | undefined;
  return JSON.parse(String(init?.body));
}

describe('testProvider 探测请求', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function stubOkFetch() {
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200, statusText: 'OK' }));
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  }

  it('带 modelId 的 testProvider messages 遇 401 不进行重试或回退 Bearer', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      statusText: 'Unauthorized',
    });
    vi.stubGlobal('fetch', fetchMock);

    const res = await testProvider(
      {
        api: 'anthropic-messages',
        apiKey: 'k',
        baseUrl: 'https://api.anyrouter.top',
      },
      'claude-sonnet-4'
    );
    expect(res.ok).toBe(false);
    expect(res.message).toBe('HTTP 401 Unauthorized');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const callInit = fetchMock.mock.calls[0]?.[1] as RequestInit | undefined;
    expect((callInit?.headers as Record<string, string>)?.['x-api-key']).toBe('k');
    expect((callInit?.headers as Record<string, string>)?.Authorization).toBeUndefined();
  });

  it('testProvider 探测请求不添加 redirect: manual，保持共享 request 的原有行为', async () => {
    const fetchMock = stubOkFetch();
    await testProvider(
      {
        api: 'anthropic-messages',
        apiKey: 'k',
        baseUrl: 'https://api.anyrouter.top',
      },
      'claude-sonnet-4'
    );
    const callInit = (fetchMock.mock.calls as unknown[][])[0]?.[1] as RequestInit | undefined;
    expect(callInit?.redirect).toBeUndefined();
  });

  it('Google 不传 maxOutputTokens: 1，避免 thinking 模型探测 502', async () => {
    const fetchMock = stubOkFetch();
    await testProvider(
      {
        api: 'google-generative-ai',
        apiKey: 'k',
        baseUrl: 'http://127.0.0.1:9831',
      },
      'gemini-3.8-flash'
    );
    const body = requestBody(fetchMock);
    const maxOutputTokens = (body.generationConfig as { maxOutputTokens?: number } | undefined)
      ?.maxOutputTokens;
    expect(maxOutputTokens).not.toBe(1);
    expect(maxOutputTokens === undefined || maxOutputTokens >= 2048).toBe(true);
  });

  it('Anthropic / OpenAI 探测上限同样避开 1 token', async () => {
    const anthropic = stubOkFetch();
    await testProvider(
      { api: 'anthropic-messages', apiKey: 'k', baseUrl: 'https://api.anthropic.com' },
      'claude-sonnet-4'
    );
    expect(requestBody(anthropic).max_tokens).not.toBe(1);

    vi.unstubAllGlobals();
    const openai = stubOkFetch();
    await testProvider(
      { api: 'openai-completions', apiKey: 'k', baseUrl: 'https://api.openai.com/v1' },
      'gpt-4o'
    );
    expect(requestBody(openai).max_tokens).not.toBe(1);
  });
});

describe('拉模型走 Chromium 网络栈', () => {
  afterEach(() => {
    net.fetch = originalNetFetch;
    proxyMocks.whenReady.mockReset();
    proxyMocks.whenReady.mockImplementation(async () => true);
    vi.unstubAllGlobals();
  });

  const config = {
    api: 'openai-responses' as const,
    apiKey: 'sk-test',
    baseUrl: 'https://done.example.test/v1',
  };

  const jsonResponse = (body: unknown, init?: ResponseInit): Response =>
    new Response(JSON.stringify(body), {
      headers: { 'Content-Type': 'application/json' },
      ...init,
    });

  it('Node fetch 被 Cloudflare 403 时仍能从 net.fetch 拿到模型列表', async () => {
    // 真机：done.5111online.uk 对 Node/undici TLS 指纹回 Cloudflare 挑战页 403，
    // 聊天能通是因为 worker 走了系统代理；设置页拉模型走主进程 Node fetch 就会挂。
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: false,
        status: 403,
        statusText: 'Forbidden',
      }))
    );
    net.fetch = vi.fn(async () => jsonResponse({ data: [{ id: 'gpt-5.6-luna' }] }));

    await expect(listModels(config)).resolves.toEqual({
      ok: true,
      models: [{ id: 'gpt-5.6-luna' }],
    });
    expect(net.fetch).toHaveBeenCalled();
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('代理解析完成前不发拉模型请求', async () => {
    let resolveReady!: () => void;
    proxyMocks.whenReady.mockReturnValue(
      new Promise<boolean>((resolve) => {
        resolveReady = () => resolve(true);
      })
    );
    const fetchMock = vi.fn(async () => jsonResponse({ data: [] }));
    net.fetch = fetchMock;

    const pending = listModels(config);
    await Promise.resolve();
    expect(fetchMock).not.toHaveBeenCalled();

    resolveReady();
    await expect(pending).resolves.toEqual({ ok: true, models: [] });
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});
