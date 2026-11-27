import { describe, expect, it } from 'vitest';
import {
  assessDefaultModel,
  defaultApprovalMode,
  isNoUsableModelError,
  type ModelCredentialContext,
  modelUsability,
  resolveChatModel,
  resolveChatReasoning,
  unusableModelError,
} from './defaultModel';
import type { ModelProvider } from './types';

function provider(
  id: string,
  modelIds: string[],
  overrides: Partial<ModelProvider> = {}
): ModelProvider {
  return {
    id,
    name: id,
    api: 'openai-completions',
    apiKey: `key-${id}`,
    baseUrl: 'https://example.test/v1',
    enabled: true,
    models: modelIds.map((modelId) => ({ id: modelId })),
    ...overrides,
  };
}

function oauthProvider(id: string, accountKey: string, modelIds: string[]): ModelProvider {
  return provider(id, modelIds, { apiKey: '', oauthAccountKey: accountKey });
}

const ready = (...keys: string[]): ModelCredentialContext => ({
  oauthCredentials: { status: 'ready', authenticatedAccountKeys: new Set(keys) },
});
const oauthError: ModelCredentialContext = {
  oauthCredentials: { status: 'error', error: 'auth unavailable' },
};

describe('modelUsability detailed reasons', () => {
  it('区分 provider/model 缺失或 disabled、API key 缺失与 OAuth ready-missing', () => {
    expect(modelUsability({ providerId: 'x', modelId: 'm' }, [], ready())).toBe('provider-missing');
    expect(
      modelUsability(
        { providerId: 'p', modelId: 'm' },
        [provider('p', ['m'], { enabled: false })],
        ready()
      )
    ).toBe('provider-disabled');
    expect(modelUsability({ providerId: 'p', modelId: 'x' }, [provider('p', ['m'])], ready())).toBe(
      'model-missing'
    );
    expect(
      modelUsability(
        { providerId: 'p', modelId: 'm' },
        [provider('p', ['m'], { models: [{ id: 'm', enabled: false }] })],
        ready()
      )
    ).toBe('model-disabled');
    expect(
      modelUsability(
        { providerId: 'p', modelId: 'm' },
        [provider('p', ['m'], { apiKey: '' })],
        ready()
      )
    ).toBe('api-key-missing');
    expect(
      modelUsability(
        { providerId: 'oauth', modelId: 'm' },
        [oauthProvider('oauth', 'anthropic', ['m'])],
        ready()
      )
    ).toBe('oauth-account-missing');
  });

  it('OAuth 非 ready 只让结构有效 OAuth 条目变未知', () => {
    expect(
      modelUsability(
        { providerId: 'oauth', modelId: 'm' },
        [oauthProvider('oauth', 'anthropic', ['m'])],
        oauthError
      )
    ).toBe('oauth-credentials-error');
    expect(
      modelUsability({ providerId: 'api', modelId: 'm' }, [provider('api', ['m'])], oauthError)
    ).toBe('usable');
  });
});

describe('assessDefaultModel：不可用只标记，绝不替换', () => {
  it('确定失效的 API 默认原样保留，只报 unavailable 与原因，即使另有可用模型', () => {
    const previous = { providerId: 'broken-api', modelId: 'old' };
    expect(
      assessDefaultModel({
        defaultModel: previous,
        providers: [
          provider('broken-api', ['old'], { apiKey: '' }),
          oauthProvider('unknown-oauth', 'anthropic', ['claude']),
          provider('fallback-api', ['next']),
        ],
        credentials: oauthError,
      })
    ).toEqual({ status: 'unavailable', defaultModel: previous, reason: 'api-key-missing' });
  });

  it('provider 被删除 / 停用、模型被删除 / 停用都只标记，不换成第一个可用模型', () => {
    const previous = { providerId: 'p', modelId: 'm' };
    const other = provider('other', ['x']);
    const cases: Array<[ModelProvider[], string]> = [
      [[other], 'provider-missing'],
      [[provider('p', ['m'], { enabled: false }), other], 'provider-disabled'],
      [[provider('p', ['n']), other], 'model-missing'],
      [[provider('p', [], { models: [{ id: 'm', enabled: false }] }), other], 'model-disabled'],
    ];
    for (const [providers, reason] of cases) {
      expect(
        assessDefaultModel({ defaultModel: previous, providers, credentials: ready() })
      ).toEqual({ status: 'unavailable', defaultModel: previous, reason });
    }
  });

  it('数据就绪后同一默认恢复为 unchanged（瞬时误判自愈）', () => {
    const previous = { providerId: 'magpie', modelId: 'swe' };
    const broken = [provider('magpie', ['swe'], { apiKey: '' }), provider('max', ['fable'])];
    expect(
      assessDefaultModel({ defaultModel: previous, providers: broken, credentials: ready() }).status
    ).toBe('unavailable');
    expect(
      assessDefaultModel({
        defaultModel: previous,
        providers: [provider('magpie', ['swe']), provider('max', ['fable'])],
        credentials: ready(),
      })
    ).toEqual({ status: 'unchanged', defaultModel: previous });
  });

  it('null 默认（首次引导）保持 unchanged', () => {
    expect(
      assessDefaultModel({
        defaultModel: null,
        providers: [provider('p', ['m'])],
        credentials: ready(),
      })
    ).toEqual({ status: 'unchanged', defaultModel: null });
  });

  it('当前默认自身是结构有效 OAuth unknown 时 defer', () => {
    const oauth = oauthProvider('oauth', 'anthropic', ['claude']);
    const previous = { providerId: 'oauth', modelId: 'claude' };
    expect(
      assessDefaultModel({
        defaultModel: previous,
        providers: [oauth, provider('api', ['m'])],
        credentials: oauthError,
      })
    ).toMatchObject({ status: 'deferred-oauth-unavailable', defaultModel: previous });
  });

  it('OAuth ready 后账号未登录：标记 oauth-account-missing，不清空', () => {
    const previous = { providerId: 'oauth', modelId: 'claude' };
    expect(
      assessDefaultModel({
        defaultModel: previous,
        providers: [oauthProvider('oauth', 'anthropic', ['claude']), provider('api', ['m'])],
        credentials: ready(),
      })
    ).toEqual({ status: 'unavailable', defaultModel: previous, reason: 'oauth-account-missing' });
  });
});

describe('unusableModelError', () => {
  it('点名模型与原因，并指向设置', () => {
    const providers = [provider('magpie', ['devin/swe-2-1'], { name: 'Magpie', apiKey: '' })];
    const resolution = resolveChatModel({
      defaultModel: { providerId: 'magpie', modelId: 'devin/swe-2-1' },
      providers: [...providers, provider('max', ['claude-fable-5'])],
      credentials: ready(),
    });
    expect(resolution).toMatchObject({
      source: 'none',
      reason: 'no-usable-model',
      unavailableDefault: {
        source: 'default',
        model: { providerId: 'magpie', modelId: 'devin/swe-2-1' },
        reason: 'api-key-missing',
      },
    });
    if (resolution.source !== 'none' || !('unavailableDefault' in resolution)) {
      throw new Error('expected unavailable default');
    }
    if (!resolution.unavailableDefault) throw new Error('expected unavailable default');
    const error = unusableModelError(resolution.unavailableDefault, providers);
    expect(error).toBe(
      'no usable model: the default model "Magpie / devin/swe-2-1" is unavailable (its provider has no API key). No other model was used. Fix or re-pick it in Settings → Models → Default model.'
    );
    expect(isNoUsableModelError(error)).toBe(true);
    expect(isNoUsableModelError('no usable model')).toBe(true);
    expect(isNoUsableModelError('no usable models here')).toBe(false);
  });

  it('项目默认不可用时点名项目默认；虚拟模型用虚拟模型名', () => {
    const error = unusableModelError(
      {
        source: 'project',
        model: { providerId: 'enso-virtual', modelId: 'auto' },
        reason: 'model-disabled',
      },
      [],
      [
        {
          id: 'auto',
          name: 'Auto',
          enabled: false,
          primary: { providerId: 'p', modelId: 'm' },
          fallbacks: [],
        },
      ]
    );
    expect(error).toContain('the project default model "Auto (virtual model)" is unavailable');
    expect(error).toContain('(the model is disabled)');
  });
});

describe('resolveChatModel', () => {
  it('普通会话仍优先自身模型，其后才用全局默认', () => {
    const providers = [provider('session', ['s']), provider('default', ['d'])];
    expect(
      resolveChatModel({
        defaultModel: { providerId: 'default', modelId: 'd' },
        lastProviderId: 'session',
        lastModelId: 's',
        providers,
        credentials: oauthError,
      })
    ).toMatchObject({ source: 'session', providerId: 'session', modelId: 's' });
  });

  it('无会话选型时优先项目默认，再分组，最后全局', () => {
    const providers = [
      provider('project', ['p']),
      provider('group', ['g']),
      provider('default', ['d']),
    ];
    const credentials = ready();
    expect(
      resolveChatModel({
        defaultModel: { providerId: 'default', modelId: 'd' },
        projectDefaultModel: { providerId: 'project', modelId: 'p' },
        groupDefaultModel: { providerId: 'group', modelId: 'g' },
        providers,
        credentials,
      })
    ).toMatchObject({ source: 'project', providerId: 'project', modelId: 'p' });
    expect(
      resolveChatModel({
        defaultModel: { providerId: 'default', modelId: 'd' },
        groupDefaultModel: { providerId: 'group', modelId: 'g' },
        providers,
        credentials,
      })
    ).toMatchObject({ source: 'group', providerId: 'group', modelId: 'g' });
    expect(
      resolveChatModel({
        defaultModel: { providerId: 'default', modelId: 'd' },
        providers,
        credentials,
      })
    ).toMatchObject({ source: 'default', providerId: 'default', modelId: 'd' });
  });

  it('会话手动选型仍覆盖项目与分组默认', () => {
    const providers = [
      provider('session', ['s']),
      provider('project', ['p']),
      provider('group', ['g']),
      provider('default', ['d']),
    ];
    expect(
      resolveChatModel({
        defaultModel: { providerId: 'default', modelId: 'd' },
        projectDefaultModel: { providerId: 'project', modelId: 'p' },
        groupDefaultModel: { providerId: 'group', modelId: 'g' },
        lastProviderId: 'session',
        lastModelId: 's',
        providers,
        credentials: ready(),
      })
    ).toMatchObject({ source: 'session', providerId: 'session', modelId: 's' });
  });

  it('项目默认不可用时回退分组，分组也不可用再回退全局', () => {
    const providers = [provider('group', ['g']), provider('default', ['d'])];
    expect(
      resolveChatModel({
        defaultModel: { providerId: 'default', modelId: 'd' },
        projectDefaultModel: { providerId: 'gone', modelId: 'x' },
        groupDefaultModel: { providerId: 'group', modelId: 'g' },
        providers,
        credentials: ready(),
      })
    ).toMatchObject({ source: 'group', providerId: 'group', modelId: 'g' });
    expect(
      resolveChatModel({
        defaultModel: { providerId: 'default', modelId: 'd' },
        projectDefaultModel: { providerId: 'gone', modelId: 'x' },
        groupDefaultModel: { providerId: 'missing', modelId: 'y' },
        providers,
        credentials: ready(),
      })
    ).toMatchObject({ source: 'default', providerId: 'default', modelId: 'd' });
  });

  it('项目默认是 OAuth unknown 时不静默回退到全局', () => {
    const oauth = oauthProvider('oauth', 'anthropic', ['claude']);
    const global = provider('default', ['d']);
    expect(
      resolveChatModel({
        defaultModel: { providerId: 'default', modelId: 'd' },
        projectDefaultModel: { providerId: 'oauth', modelId: 'claude' },
        providers: [oauth, global],
        credentials: oauthError,
      })
    ).toMatchObject({ source: 'none', reason: 'oauth-credentials-error' });
  });
});

describe('resolveChatModel 严格不替换', () => {
  it('新会话：全局默认不可用时不挑第一个可用模型，返回 none 并带原因', () => {
    const resolution = resolveChatModel({
      defaultModel: { providerId: 'magpie', modelId: 'swe' },
      providers: [provider('magpie', ['swe'], { enabled: false }), provider('max', ['fable'])],
      credentials: ready(),
    });
    expect(resolution).toMatchObject({
      providerId: null,
      modelId: null,
      source: 'none',
      reason: 'no-usable-model',
      unavailableDefault: { source: 'default', reason: 'provider-disabled' },
    });
  });

  it('全局默认不可用但项目默认可用：照用项目默认，不阻断', () => {
    expect(
      resolveChatModel({
        defaultModel: { providerId: 'gone', modelId: 'x' },
        projectDefaultModel: { providerId: 'project', modelId: 'p' },
        providers: [provider('project', ['p']), provider('other', ['o'])],
        credentials: ready(),
      })
    ).toMatchObject({ source: 'project', providerId: 'project', modelId: 'p' });
  });

  it('没有任何默认（首次引导）时 none 不带 unavailableDefault', () => {
    const resolution = resolveChatModel({
      defaultModel: null,
      providers: [provider('p', ['m'])],
      credentials: ready(),
    });
    expect(resolution).toMatchObject({ source: 'none', reason: 'no-usable-model' });
    expect(resolution).not.toHaveProperty('unavailableDefault');
  });
});

describe('resolveChatReasoning', () => {
  it('推理深度随项目 → 分组 → 全局回落，未设置不覆盖下一层', () => {
    expect(
      resolveChatReasoning({
        projectReasoningEnabled: false,
        projectThinkingLevel: 'high',
        groupReasoningEnabled: true,
        groupThinkingLevel: 'low',
        defaultReasoningEnabled: true,
        defaultThinkingLevel: 'medium',
      })
    ).toEqual({ reasoningEnabled: false, thinkingLevel: 'high' });
    expect(
      resolveChatReasoning({
        groupReasoningEnabled: false,
        groupThinkingLevel: 'low',
        defaultReasoningEnabled: true,
        defaultThinkingLevel: 'medium',
      })
    ).toEqual({ reasoningEnabled: false, thinkingLevel: 'low' });
    expect(
      resolveChatReasoning({
        defaultReasoningEnabled: true,
        defaultThinkingLevel: 'xhigh',
      })
    ).toEqual({ reasoningEnabled: true, thinkingLevel: 'xhigh' });
  });
});

describe('defaultApprovalMode', () => {
  it('无上次档位：代审模型可用 → assistant，未选或不可用 → full', () => {
    const providers = [provider('p', ['m'])];
    expect(defaultApprovalMode({ providerId: 'p', modelId: 'm' }, providers, ready())).toBe(
      'assistant'
    );
    expect(defaultApprovalMode(null, providers, ready())).toBe('full');
    expect(defaultApprovalMode({ providerId: 'p', modelId: 'gone' }, providers, ready())).toBe(
      'full'
    );
  });

  it('记住上次非代审档，不因代审模型可用回滚 assistant', () => {
    const providers = [provider('p', ['m'])];
    const reviewer = { providerId: 'p', modelId: 'm' };
    expect(defaultApprovalMode(reviewer, providers, ready(), 'supervised')).toBe('supervised');
    expect(defaultApprovalMode(reviewer, providers, ready(), 'auto-edits')).toBe('auto-edits');
    expect(defaultApprovalMode(reviewer, providers, ready(), 'full')).toBe('full');
  });

  it('分类器专用供应商（Jev）可作代审：需启用、有 apiKey、模型在清单内', () => {
    const jev = provider('jev', ['jev-latest'], {
      api: 'typesafe-system-one',
      baseUrl: 'https://api.typesafe.ai/v1/',
    });
    const reviewer = { providerId: 'jev', modelId: 'jev-latest' };
    expect(defaultApprovalMode(reviewer, [jev], ready())).toBe('assistant');
    expect(defaultApprovalMode(reviewer, [{ ...jev, apiKey: '' }], ready())).toBe('full');
    expect(defaultApprovalMode(reviewer, [{ ...jev, enabled: false }], ready())).toBe('full');
    expect(defaultApprovalMode({ ...reviewer, modelId: 'gone' }, [jev], ready())).toBe('full');
    expect(
      defaultApprovalMode(
        reviewer,
        [{ ...jev, models: [{ id: 'jev-latest', enabled: false }] }],
        ready()
      )
    ).toBe('full');
  });

  it('上次是 assistant 但代审模型不可用时回落 full', () => {
    const providers = [provider('p', ['m'])];
    expect(defaultApprovalMode(null, providers, ready(), 'assistant')).toBe('full');
    expect(
      defaultApprovalMode({ providerId: 'p', modelId: 'gone' }, providers, ready(), 'assistant')
    ).toBe('full');
  });
});
