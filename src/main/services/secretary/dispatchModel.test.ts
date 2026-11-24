import type { ModelRef } from '@shared/types';
import { VIRTUAL_PROVIDER_ID, type VirtualModelEntry } from '@shared/virtualModels';
import { describe, expect, it } from 'vitest';
import {
  type DispatchModelDeps,
  dispatchModelChoices,
  dispatchProviderId,
  resolveDispatchModel,
} from './dispatchModel';

const providers = [
  {
    id: 'bed36597',
    name: 'Max',
    models: [{ id: 'claude-opus-5-5' }, { id: 'off', enabled: false }],
  },
  { id: 'aaa', name: 'kencc', models: [{ id: 'k1' }] },
  { id: 'bbb', name: 'kencc', models: [{ id: 'k2' }] },
  { id: 'ccc', name: 'Dead', models: [{ id: 'd1' }] },
];

describe('dispatchProviderId', () => {
  it('精确 id 原样返回', () => {
    expect(dispatchProviderId('bed36597', providers)).toBe('bed36597');
  });

  it('显示名唯一命中时换成 id，忽略大小写与空白', () => {
    expect(dispatchProviderId(' max ', providers)).toBe('bed36597');
  });

  it('重名或无匹配时不猜，原样返回', () => {
    expect(dispatchProviderId('kencc', providers)).toBe('kencc');
    expect(dispatchProviderId('anthropic', providers)).toBe('anthropic');
  });
});

describe('dispatchModelChoices', () => {
  it('只列可用模型，带名字与精确 id', () => {
    const text = dispatchModelChoices(providers, (providerId) => providerId !== 'ccc');
    expect(text).toContain('Max: providerId "bed36597", modelId claude-opus-5-5');
    expect(text).not.toContain('off');
    expect(text).not.toContain('Dead');
    expect(text).toContain('providerId "aaa", modelId k1');
  });

  it('没有可用模型时为空', () => {
    expect(dispatchModelChoices(providers, () => false)).toBe('');
  });

  it('单个 provider 模型过多时截断', () => {
    const many = [{ id: 'p', name: 'P', models: [{ id: 'a' }, { id: 'b' }, { id: 'c' }] }];
    expect(dispatchModelChoices(many, () => true, 2)).toBe(
      'P: providerId "p", modelId a, b (+1 more)'
    );
  });
});

const AUTO_ID = '7b11a559-f632-4648-a52b-f0c2e536e19f';
const auto: VirtualModelEntry = {
  id: AUTO_ID,
  name: 'Auto',
  enabled: true,
  primary: { providerId: 'bed36597', modelId: 'claude-opus-5-5' },
  fallbacks: [],
};
const virtualModels: VirtualModelEntry[] = [
  auto,
  { ...auto, id: 'v-off', name: 'Paused', enabled: false },
  { ...auto, id: 'v-dead', name: 'Broken', primary: { providerId: 'ccc', modelId: 'd1' } },
];

/** 假解析：ccc 没凭证；虚拟模型要启用且主成员可用 */
function deps(): DispatchModelDeps {
  const physical = (ref: ModelRef) =>
    ref.providerId !== 'ccc' &&
    providers.some(
      (provider) =>
        provider.id === ref.providerId &&
        provider.models.some((model) => model.id === ref.modelId && model.enabled !== false)
    );
  const resolve: DispatchModelDeps['resolve'] = (ref) => {
    if (ref.providerId === VIRTUAL_PROVIDER_ID) {
      const entry = virtualModels.find((item) => item.id === ref.modelId);
      return entry?.enabled && physical(entry.primary)
        ? { ok: true, ref }
        : { ok: false, error: 'Model is unavailable: model-missing' };
    }
    return physical(ref) ? { ok: true, ref } : { ok: false, error: 'Model is unavailable' };
  };
  return { providers, virtualModels, resolve, usable: physical };
}

describe('resolveDispatchModel', () => {
  const virtual = { providerId: VIRTUAL_PROVIDER_ID, modelId: AUTO_ID };

  it('providerId enso-virtual + 虚拟模型 id：解析成该虚拟模型，带上思考档位', () => {
    expect(resolveDispatchModel({ ...virtual, thinkingLevel: 'high' }, deps())).toEqual({
      ok: true,
      model: { ...virtual, thinkingLevel: 'high' },
    });
  });

  it('modelId 直接填虚拟模型 id 时，providerId 不是真实 provider 也认', () => {
    expect(resolveDispatchModel({ providerId: 'Auto', modelId: AUTO_ID }, deps())).toEqual({
      ok: true,
      model: virtual,
    });
  });

  it('providerId enso-virtual + 虚拟模型名称（忽略大小写）', () => {
    expect(
      resolveDispatchModel({ providerId: VIRTUAL_PROVIDER_ID, modelId: ' auto ' }, deps())
    ).toEqual({
      ok: true,
      model: virtual,
    });
  });

  it('真实模型照旧：provider 显示名唯一命中时换成 id', () => {
    expect(resolveDispatchModel({ providerId: 'Max', modelId: 'claude-opus-5-5' }, deps())).toEqual(
      {
        ok: true,
        model: { providerId: 'bed36597', modelId: 'claude-opus-5-5' },
      }
    );
  });

  it('失败时清单列出可用虚拟模型的名字与传法，不列被禁用或成员都不可用的', () => {
    const result = resolveDispatchModel({ providerId: 'nope', modelId: 'x' }, deps());
    expect(result.ok).toBe(false);
    const error = (result as { error: string }).error;
    expect(error).toContain('Max: providerId "bed36597", modelId claude-opus-5-5');
    expect(error).toContain(
      `Auto (virtual model): providerId "${VIRTUAL_PROVIDER_ID}", modelId "${AUTO_ID}"`
    );
    expect(error).not.toContain('Paused');
    expect(error).not.toContain('Broken');
  });

  it('指定的虚拟模型被禁用时拒绝，不回退', () => {
    const result = resolveDispatchModel(
      { providerId: VIRTUAL_PROVIDER_ID, modelId: 'v-off' },
      deps()
    );
    expect(result.ok).toBe(false);
  });
});
