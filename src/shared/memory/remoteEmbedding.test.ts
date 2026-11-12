import { describe, expect, it } from 'vitest';
import { translate } from '../i18n';
import {
  isLikelyEmbeddingModelId,
  REMOTE_EMBEDDING_SENTINEL_MODEL,
  type RemoteEmbeddingIssue,
  remoteEmbeddingIssue,
  remoteEmbeddingIssueMessage,
} from './remoteEmbedding';

const apiProvider = (models: string[] = ['text-embedding-3-small']) => ({
  name: 'Acme',
  baseUrl: 'https://api.acme.invalid/v1',
  apiKey: 'k',
  models: models.map((id) => ({ id })),
});

const zh = (issue: RemoteEmbeddingIssue, params?: { provider?: string; model?: string }) =>
  remoteEmbeddingIssueMessage(issue, params ?? {}, (key, p) => translate('zh', key, p));

describe('isLikelyEmbeddingModelId', () => {
  it.each([
    'text-embedding-3-small',
    'openai/text-embedding-3-large',
    'Qwen3-Embedding-8B',
    'BAAI/bge-m3',
    'doubao-embedding-large',
    'jina-embeddings-v3',
    'nomic-embed-text',
    'voyage-3',
    'multilingual-e5-large',
    'thenlper/gte-large',
  ])('认得向量模型 %s', (id) => {
    expect(isLikelyEmbeddingModelId(id)).toBe(true);
  });

  it.each(['Qwen4-Max-Preview', 'gpt-4o', 'claude-sonnet-4-5', 'gemini-2.5-pro', 'deepseek-chat'])(
    '对话模型 %s 不算向量模型',
    (id) => {
      expect(isLikelyEmbeddingModelId(id)).toBe(false);
    }
  );
});

describe('remoteEmbeddingIssue', () => {
  it('凭证与模型都可用时没有问题', () => {
    expect(
      remoteEmbeddingIssue({
        providerId: 'p',
        provider: apiProvider(),
        modelId: 'text-embedding-3-small',
      })
    ).toBeNull();
  });

  it('区分未选服务商 / 服务商被删 / 缺 baseUrl / 只有订阅', () => {
    expect(remoteEmbeddingIssue({ providerId: null, provider: undefined, modelId: 'x' })).toBe(
      'no-provider'
    );
    expect(remoteEmbeddingIssue({ providerId: 'p', provider: undefined, modelId: 'x' })).toBe(
      'provider-missing'
    );
    expect(
      remoteEmbeddingIssue({
        providerId: 'p',
        provider: { ...apiProvider(), baseUrl: ' ' },
        modelId: 'x',
      })
    ).toBe('no-base-url');
    expect(
      remoteEmbeddingIssue({
        providerId: 'p',
        provider: { ...apiProvider(), apiKey: '', oauthAccountKey: 'anthropic' },
        modelId: 'text-embedding-3-small',
      })
    ).toBe('no-api-key');
  });

  it('对话模型：服务商有向量模型时提示换模型，完全没有时提示去添加', () => {
    expect(
      remoteEmbeddingIssue({
        providerId: 'p',
        provider: apiProvider(['Qwen4-Max-Preview', 'text-embedding-v3']),
        modelId: 'Qwen4-Max-Preview',
      })
    ).toBe('not-embedding-model');
    expect(
      remoteEmbeddingIssue({
        providerId: 'p',
        provider: apiProvider(['Qwen4-Max-Preview']),
        modelId: 'Qwen4-Max-Preview',
      })
    ).toBe('no-embedding-models');
  });

  it('哨兵 / 空模型视为未选模型', () => {
    expect(
      remoteEmbeddingIssue({
        providerId: 'p',
        provider: apiProvider(),
        modelId: REMOTE_EMBEDDING_SENTINEL_MODEL,
      })
    ).toBe('no-model');
    expect(remoteEmbeddingIssue({ providerId: 'p', provider: apiProvider(), modelId: null })).toBe(
      'no-model'
    );
  });

  it('脏输入（models 缺失）不抛', () => {
    expect(
      remoteEmbeddingIssue({
        providerId: 'p',
        provider: { baseUrl: 'https://x.invalid', apiKey: 'k' },
        modelId: 'gpt-4o',
      })
    ).toBe('no-embedding-models');
  });
});

describe('remoteEmbeddingIssueMessage', () => {
  it('中文文案点明原因与出路', () => {
    expect(zh('no-provider')).toContain('选择');
    expect(zh('provider-missing')).toContain('已被删除');
    expect(zh('no-base-url', { provider: 'Acme' })).toContain('Base URL');
    const oauth = zh('no-api-key', { provider: 'Claude' });
    expect(oauth).toContain('API Key');
    expect(oauth).toContain('订阅登录不能用于向量化');
    expect(oauth).toContain('本地向量模型');
    const chat = zh('not-embedding-model', { model: 'Qwen4-Max-Preview' });
    expect(chat).toContain('Qwen4-Max-Preview');
    expect(chat).toContain('对话模型');
    expect(chat).toContain('/embeddings');
    expect(zh('no-embedding-models', { provider: 'Acme', model: 'gpt-4o' })).toContain(
      '没有向量模型'
    );
  });

  it('英文环境不出现未翻译的占位符', () => {
    const en = remoteEmbeddingIssueMessage('no-api-key', { provider: 'Claude' }, (key, p) =>
      translate('en', key, p)
    );
    expect(en).toContain('Claude');
    expect(en).not.toContain('{{');
  });
});
