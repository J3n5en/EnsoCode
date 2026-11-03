import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { registerPluginSlot, resetPluginSlots } from './registry';
import { PluginComposerSlots, PluginSlotErrorBoundary } from './slots';

beforeEach(() => resetPluginSlots());

describe('插件挂点错误隔离', () => {
  it('出错时隐藏该挂点并上报插件与挂点', () => {
    const error = new Error('boom');
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const boundary = new PluginSlotErrorBoundary({
      pluginId: 'a.b',
      slot: 'composer.left',
      children: 'visible',
    });
    expect(boundary.render()).toBe('visible');
    expect(PluginSlotErrorBoundary.getDerivedStateFromError()).toEqual({ failed: true });
    boundary.componentDidCatch(error);
    expect(spy).toHaveBeenCalledWith('[plugin] a.b 挂点 composer.left 渲染失败', error);
    boundary.state = { failed: true };
    expect(boundary.render()).toBeNull();
    spy.mockRestore();
  });

  it('同一插件的多个挂点各自保留', () => {
    registerPluginSlot({
      pluginId: 'a.b',
      slot: 'composer.left',
      component: () => createElement('i', { 'data-slot': 'one' }, 'one'),
    });
    registerPluginSlot({
      pluginId: 'a.b',
      slot: 'composer.left',
      component: () => createElement('i', { 'data-slot': 'two' }, 'two'),
    });
    const html = renderToStaticMarkup(
      createElement(PluginComposerSlots, { side: 'left', sessionId: 's1', draft: '', busy: false })
    );
    expect(html).toContain('data-slot="one"');
    expect(html).toContain('data-slot="two"');
  });
});
