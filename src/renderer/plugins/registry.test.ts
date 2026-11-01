import { beforeEach, describe, expect, it } from 'vitest';
import {
  clearPluginSlots,
  parsePluginFence,
  pluginBlock,
  pluginComposerSlots,
  pluginMessageActions,
  pluginToolCard,
  registerPluginSlot,
  resetPluginSlots,
} from './registry';

beforeEach(() => resetPluginSlots());

const component = () => null;

describe('插件挂点登记', () => {
  it('消息动作按位置取回，卸载后消失', () => {
    const dispose = registerPluginSlot({
      pluginId: 'a.b',
      slot: 'message.action',
      position: 'right',
      component,
    });
    expect(pluginMessageActions('right')).toHaveLength(1);
    expect(pluginMessageActions('left')).toHaveLength(0);
    dispose();
    expect(pluginMessageActions('right')).toHaveLength(0);
  });

  it('工具卡片按插件和工具名匹配', () => {
    registerPluginSlot({ pluginId: 'a.b', slot: 'tool.card', toolName: 'lookup', component });
    expect(pluginToolCard('a.b', 'lookup')).toBeTruthy();
    expect(pluginToolCard('a.b', 'other')).toBeUndefined();
    expect(pluginToolCard('c.d', 'lookup')).toBeUndefined();
  });

  it('代码块语言不区分大小写', () => {
    registerPluginSlot({ pluginId: 'a.b', slot: 'block', language: 'Chart', component });
    expect(pluginBlock('a.b', 'chart')).toBeTruthy();
    expect(pluginBlock('a.b', 'CHART')).toBeTruthy();
  });

  it('clearPluginSlots 只清该插件', () => {
    registerPluginSlot({ pluginId: 'a.b', slot: 'block', language: 'x', component });
    registerPluginSlot({ pluginId: 'c.d', slot: 'block', language: 'x', component });
    clearPluginSlots('a.b');
    expect(pluginBlock('a.b', 'x')).toBeUndefined();
    expect(pluginBlock('c.d', 'x')).toBeTruthy();
  });

  it('非法挂点或缺少必需字段时抛错', () => {
    expect(() =>
      registerPluginSlot({ pluginId: 'a.b', slot: 'nope' as never, component })
    ).toThrow();
    expect(() =>
      registerPluginSlot({ pluginId: 'a.b', slot: 'message.action', component })
    ).toThrow();
    for (const slot of ['composer.activity', 'composer.dock'])
      expect(() =>
        registerPluginSlot({ pluginId: 'a.b', slot: slot as never, component })
      ).toThrow();
  });

  it('解析插件代码块标记', () => {
    expect(parsePluginFence('a.b:chart')).toEqual({ pluginId: 'a.b', lang: 'chart' });
    expect(parsePluginFence('example.demo.sub:lang')).toEqual({
      pluginId: 'example.demo.sub',
      lang: 'lang',
    });
    expect(parsePluginFence('mermaid')).toBeNull();
    expect(parsePluginFence('NotAnId:x')).toBeNull();
    expect(parsePluginFence('a.b:')).toBeNull();
  });

  it('输入框挂点按左右取回', () => {
    registerPluginSlot({ pluginId: 'a.b', slot: 'composer.left', component });
    registerPluginSlot({ pluginId: 'a.b', slot: 'composer.right', component });
    expect(pluginComposerSlots('left')).toHaveLength(1);
    expect(pluginComposerSlots('right')).toHaveLength(1);
  });
});
