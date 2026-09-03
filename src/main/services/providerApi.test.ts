import { withVersionSegment } from '@shared/providerCatalog';
import type { ModelApiKind } from '@shared/types';
import { describe, expect, it, vi } from 'vitest';
import {
  extractModelEntries,
  listModels,
  resolveBase,
  testProvider,
  toMessage,
} from './providerApi';

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
});
