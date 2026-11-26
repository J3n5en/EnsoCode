import { describe, expect, it } from 'vitest';
import { isPluginPresetId, parsePluginPresetId, pluginPresetId, presetOverlay } from './preset';

describe('plugin preset id', () => {
  it('拼出并解析 plugin:<插件 id>:<预设 id>', () => {
    const id = pluginPresetId('example.demo', 'review');
    expect(id).toBe('plugin:example.demo:review');
    expect(parsePluginPresetId(id)).toEqual({ pluginId: 'example.demo', localId: 'review' });
    expect(isPluginPresetId(id)).toBe(true);
  });

  it('用户预设 id 和缺段的值都不是插件预设', () => {
    expect(parsePluginPresetId('0c9a6b7e-1c2d-4e5f-8a9b-0c1d2e3f4a5b')).toBeUndefined();
    expect(parsePluginPresetId('plugin:example.demo')).toBeUndefined();
    expect(parsePluginPresetId('plugin:example:')).toBeUndefined();
    expect(parsePluginPresetId('plugin:Example.demo:review')).toBeUndefined();
    expect(isPluginPresetId('default')).toBe(false);
  });
});

describe('presetOverlay', () => {
  const resolve = (preset?: unknown) => () => preset as never;
  const user = {
    id: 'u',
    name: 'U',
    skillIds: [],
    mcpServerIds: [],
    pluginPresetIds: ['plugin:enso.pstack:poteto', 'plugin:example.demo:review'],
  };

  it('直接选插件预设：单个必需叠加', () => {
    expect(presetOverlay('plugin:enso.pstack:poteto', resolve(undefined))).toEqual({
      pluginPresetIds: ['plugin:enso.pstack:poteto'],
      required: true,
    });
  });

  it('自建预设叠加多个插件预设：按数组顺序返回', () => {
    expect(presetOverlay('u', resolve(user))).toEqual({
      preset: user,
      pluginPresetIds: ['plugin:enso.pstack:poteto', 'plugin:example.demo:review'],
      required: false,
    });
  });

  it('旧单值字段迁移为数组首元素', () => {
    const legacy = {
      ...user,
      pluginPresetIds: undefined,
      pluginPresetId: 'plugin:enso.pstack:poteto',
    };
    expect(presetOverlay('u', resolve(legacy))).toEqual({
      preset: legacy,
      pluginPresetIds: ['plugin:enso.pstack:poteto'],
      required: false,
    });
  });

  it('数组为空且无旧字段时不带插件预设', () => {
    const plain = { ...user, pluginPresetIds: undefined, pluginPresetId: undefined };
    expect(presetOverlay('u', resolve(plain))).toEqual({ preset: plain, required: false });
    expect(presetOverlay('u', resolve({ ...plain, pluginPresetIds: [] }))).toEqual({
      preset: { ...plain, pluginPresetIds: [] },
      required: false,
    });
  });

  it('非法 id 被过滤，旧字段不重复并入', () => {
    const mixed = {
      ...user,
      pluginPresetIds: ['plugin:enso.pstack:poteto', 'not-plugin'],
      pluginPresetId: 'plugin:enso.pstack:poteto',
    };
    expect(presetOverlay('u', resolve(mixed))).toEqual({
      preset: mixed,
      pluginPresetIds: ['plugin:enso.pstack:poteto'],
      required: false,
    });
  });
});
