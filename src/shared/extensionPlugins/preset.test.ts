import { describe, expect, it } from 'vitest';
import { isPluginPresetId, parsePluginPresetId, pluginPresetId } from './preset';

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
