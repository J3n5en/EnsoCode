import { describe, expect, it } from 'vitest';
import { pluginPresetModel } from './usePluginPresets';

const presets = [
  { id: 'plugin:enso.example.notes:fast', model: { providerId: 'openai', modelId: 'gpt-4.1' } },
  { id: 'plugin:enso.example.notes:plain' },
  { id: 'plugin:enso.example.notes:blank', model: { providerId: '', modelId: 'x' } },
];

describe('插件预设模型', () => {
  it('选中带模型的预设时返回要切过去的模型', () => {
    expect(pluginPresetModel('plugin:enso.example.notes:fast', presets)).toEqual({
      providerId: 'openai',
      modelId: 'gpt-4.1',
    });
  });

  it('没有模型、模型为空或不是插件预设时不改输入框模型', () => {
    expect(pluginPresetModel('plugin:enso.example.notes:plain', presets)).toBeNull();
    expect(pluginPresetModel('plugin:enso.example.notes:blank', presets)).toBeNull();
    expect(pluginPresetModel('default', presets)).toBeNull();
    expect(pluginPresetModel('plugin:missing:x', presets)).toBeNull();
  });
});
