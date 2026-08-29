import type { ModelApiKind } from '@shared/types';
import { describe, expect, it, vi } from 'vitest';
import {
  extractModelIds,
  listModels,
  resolveBase,
  testProvider,
  toMessage,
  withVersionSegment,
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

describe('extractModelIds', () => {
  it('OpenAI 兼容：取 data[].id', () => {
    const data = { data: [{ id: 'gpt-5' }, { id: 'gpt-4o' }] };
    expect(extractModelIds('openai-completions', data)).toEqual(['gpt-5', 'gpt-4o']);
    expect(extractModelIds('anthropic-messages', data)).toEqual(['gpt-5', 'gpt-4o']);
  });

  it('Gemini：取 models[].name 并剥掉 models/ 前缀', () => {
    const data = { models: [{ name: 'models/gemini-2.0-flash' }, { name: 'models/gemini-pro' }] };
    expect(extractModelIds('google-generative-ai', data)).toEqual([
      'gemini-2.0-flash',
      'gemini-pro',
    ]);
  });

  it('Ollama：优先 model 字段，回退 name', () => {
    const data = { models: [{ model: 'llama3:8b', name: 'llama3' }, { name: 'qwen' }] };
    expect(extractModelIds('ollama', data)).toEqual(['llama3:8b', 'qwen']);
  });

  it('响应结构不符时返回空数组而不是抛错', () => {
    expect(extractModelIds('openai-completions', {})).toEqual([]);
    expect(extractModelIds('openai-completions', { data: 'not-an-array' })).toEqual([]);
    expect(extractModelIds('ollama', { models: null })).toEqual([]);
    expect(extractModelIds('google-generative-ai', {})).toEqual([]);
  });

  it('过滤掉 id 缺失或类型不对的条目', () => {
    const data = { data: [{ id: 'ok' }, { id: 123 }, {}, null] };
    expect(extractModelIds('openai-completions', data)).toEqual(['ok']);
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
