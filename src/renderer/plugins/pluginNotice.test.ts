import { pluginFocusSettingsLink } from '@shared/extensionPlugins/pluginProtocol';
import { describe, expect, it } from 'vitest';
import { describePluginNotice } from './pluginNotice';

describe('describePluginNotice', () => {
  it('三种通知都带插件名，拦截和待授权有按钮，自动更新可查看', () => {
    expect(
      describePluginNotice({ kind: 'inject-denied', pluginId: 'example.demo', name: 'Demo' })
    ).toMatchObject({
      type: 'warning',
      params: { name: 'Demo' },
      actionKey: 'Turn on',
      pluginId: 'example.demo',
    });
    expect(
      describePluginNotice({
        kind: 'update-needs-approval',
        pluginId: 'example.demo',
        name: 'Demo',
        version: '2.0.0',
      })
    ).toMatchObject({
      actionKey: 'Review permissions',
      params: { name: 'Demo', version: '2.0.0' },
    });
    expect(
      describePluginNotice({
        kind: 'auto-updated',
        pluginId: 'example.demo',
        name: 'Demo',
        version: '1.2.0',
      })
    ).toMatchObject({
      type: 'success',
      actionKey: 'View',
      params: { version: '1.2.0' },
    });
    expect(describePluginNotice({ kind: 'nope' })).toBeNull();
  });

  it('按钮打开插件设置并带上要展开的插件', () => {
    expect(pluginFocusSettingsLink('example.demo')).toEqual({
      category: 'plugins',
      rowId: 'plugins.enso',
      pluginId: 'example.demo',
    });
  });
});
