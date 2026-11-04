import { parseHTML } from 'linkedom';
import { act, createElement, type ReactElement } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { registerPluginSlot, resetPluginSlots } from './registry';
import { PluginComposerSlots, PluginSlotErrorBoundary, PluginThinkingBody } from './slots';

const THINKING_BODY_CLASS = [
  't-acc-reveal mt-1 ml-[10px] border-l-2 border-border py-0.5 pl-[19px]',
  'text-[13px] leading-relaxed text-muted-foreground whitespace-pre-wrap',
].join(' ');

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

  it('出错且提供了回退内容时渲染回退，而不是空', () => {
    const boundary = new PluginSlotErrorBoundary({
      pluginId: 'a.b',
      slot: 'thinking.body',
      fallback: '不能丢的原文',
      children: '插件',
    });
    boundary.state = { failed: true };
    expect(boundary.render()).toBe('不能丢的原文');
  });

  it('同一插件的多个挂点各自保留', () => {
    registerPluginSlot({
      pluginId: 'a.b',
      slot: 'composer.left',
      component: (props) =>
        createElement(
          'i',
          { 'data-slot': 'one', 'data-preset': String(props.pluginPresetId) },
          'one'
        ),
    });
    registerPluginSlot({
      pluginId: 'a.b',
      slot: 'composer.left',
      component: (props) =>
        createElement(
          'i',
          { 'data-slot': 'two', 'data-preset': String(props.pluginPresetId) },
          'two'
        ),
    });
    const html = renderToStaticMarkup(
      createElement(PluginComposerSlots, {
        side: 'left',
        sessionId: 's1',
        draft: '',
        busy: false,
        pluginPresetId: 'plugin:enso.pstack:poteto',
      })
    );
    expect(html).toContain('data-slot="one"');
    expect(html).toContain('data-slot="two"');
    expect(html).toContain('data-preset="plugin:enso.pstack:poteto"');
  });

  it('没有思考正文挂点时仍渲染原文段落', () => {
    const html = renderToStaticMarkup(
      createElement(PluginThinkingBody, { text: '原文', streaming: false, itemKey: 'k1' })
    );
    expect(html).toBe(`<p class="${THINKING_BODY_CLASS}">原文</p>`);
  });

  it('多个思考正文挂点只渲染先注册的，并传入原文与流式状态', () => {
    registerPluginSlot({
      pluginId: 'a.b',
      slot: 'thinking.body',
      component: (props) =>
        createElement(
          'span',
          {
            'data-thinking': 'first',
            'data-streaming': String(props.streaming),
            'data-key': props.itemKey,
          },
          String(props.text)
        ),
    });
    registerPluginSlot({
      pluginId: 'c.d',
      slot: 'thinking.body',
      component: () => createElement('span', { 'data-thinking': 'second' }, '后注册'),
    });
    const html = renderToStaticMarkup(
      createElement(PluginThinkingBody, { text: '原文', streaming: true, itemKey: 'k1' })
    );
    expect(html.startsWith(`<div class="${THINKING_BODY_CLASS}">`)).toBe(true);
    expect(html).toContain('data-thinking="first"');
    expect(html).toContain('data-streaming="true"');
    expect(html).toContain('data-key="k1"');
    expect(html).toContain('原文');
    expect(html).not.toContain('data-thinking="second"');
    expect(html).not.toContain('<p');
  });

  it('思考正文组件抛错时回退显示原文', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    registerPluginSlot({
      pluginId: 'a.b',
      slot: 'thinking.body',
      component: () => {
        throw new Error('翻译失败');
      },
    });
    const view = await renderClient(
      createElement(PluginThinkingBody, {
        text: '不能丢的原文',
        streaming: false,
        itemKey: 'k1',
      })
    );
    try {
      expect(view.container.querySelector('div')?.textContent).toBe('不能丢的原文');
      expect(view.container.querySelector('p')).toBeNull();
      expect(view.container.innerHTML).not.toContain('翻译失败');
    } finally {
      await view.unmount();
      spy.mockRestore();
    }
  });

  it('抛错的思考正文卸掉后渲染下一个插件', async () => {
    const dispose = registerPluginSlot({
      pluginId: 'a.b',
      slot: 'thinking.body',
      component: () => {
        throw new Error('翻译失败');
      },
    });
    registerPluginSlot({
      pluginId: 'c.d',
      slot: 'thinking.body',
      component: () => createElement('b', null, '第二个'),
    });
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const view = await renderClient(
      createElement(PluginThinkingBody, { text: '不能丢的原文', streaming: false, itemKey: 'k1' })
    );
    try {
      expect(view.container.textContent).toBe('不能丢的原文');
      await act(async () => {
        dispose();
      });
      expect(view.container.querySelector('b')?.textContent).toBe('第二个');
    } finally {
      await view.unmount();
      spy.mockRestore();
    }
  });

  it('思考正文挂点后注册时替换原文', async () => {
    const view = await renderClient(
      createElement(PluginThinkingBody, { text: '原文', streaming: false, itemKey: 'k1' })
    );
    try {
      expect(view.container.querySelector('p')?.textContent).toBe('原文');
      await act(async () => {
        registerPluginSlot({
          pluginId: 'a.b',
          slot: 'thinking.body',
          component: () => createElement('b', null, '译文'),
        });
      });
      expect(view.container.querySelector('b')?.textContent).toBe('译文');
      expect(view.container.querySelector('p')).toBeNull();
    } finally {
      await view.unmount();
    }
  });
});

async function renderClient(node: ReactElement): Promise<{
  container: HTMLElement;
  unmount: () => Promise<void>;
}> {
  const dom = parseHTML('<html><body><div id="root"></div></body></html>');
  vi.stubGlobal('window', dom.window);
  vi.stubGlobal('document', dom.document);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const container = dom.document.getElementById('root') as unknown as HTMLElement;
  const root = createRoot(container);
  await act(async () => {
    root.render(node);
  });
  return {
    container,
    unmount: async () => {
      await act(async () => {
        root.unmount();
      });
      vi.unstubAllGlobals();
    },
  };
}
