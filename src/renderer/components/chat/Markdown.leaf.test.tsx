import { parseHTML } from 'linkedom';
import { act, createElement, type ReactElement, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { registerPluginSlot, resetPluginSlots } from '@/plugins/registry';
import { Markdown } from './Markdown';

vi.mock('@/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock('@/lib/sidePanelDock', () => ({ openSidePanelFile: () => {} }));
vi.mock('@/stores/settings', () => ({
  useSettingsStore: (
    select?: (state: { contextMenuOpen: never[]; projects: never[]; language: string }) => unknown
  ) =>
    select
      ? select({ contextMenuOpen: [], projects: [], language: 'zh' })
      : { contextMenuOpen: [], projects: [], language: 'zh' },
}));

beforeEach(() => {
  resetPluginSlots();
  vi.unstubAllGlobals();
});

const SAMPLE = [
  '段落',
  '',
  '## 标题',
  '',
  '- **加粗** 文本',
  '',
  '1. 有序项',
  '',
  '- 宽松甲',
  '',
  '- 宽松乙',
  '',
  '| A | B |',
  '| - | - |',
  '| 单元格 | 二 |',
  '',
  '> 引用文字',
  '',
  '```',
  'code',
  '```',
  '',
  '#### 四级',
].join('\n');

const LEAF = { messageIndex: 4, sessionId: 'sess' as string | null };

function render(
  text: string,
  leaf?: { messageIndex: number; sessionId: string | null },
  streaming = false
) {
  return renderToStaticMarkup(
    createElement(Markdown, { text, streaming, ...(leaf ? { leaf } : {}) })
  );
}

describe('message.leaf', () => {
  it('没传 leaf 或没有插件时输出与原来一致', () => {
    const plain = render(SAMPLE);
    expect(render(SAMPLE, LEAF)).toBe(plain);
    registerPluginSlot({
      pluginId: 'a.b',
      slot: 'message.leaf',
      component: () => createElement('i', { 'data-leaf': 'yes' }),
    });
    expect(render(SAMPLE)).toBe(plain);
    expect(render(SAMPLE)).not.toContain('data-leaf');
  });

  it('段落、标题、列表、表格和引用拿到行内原文，代码块不触发', () => {
    const seen: {
      source: string;
      final: boolean;
      messageIndex: number;
      sessionId: string | null;
    }[] = [];
    registerPluginSlot({
      pluginId: 'a.b',
      slot: 'message.leaf',
      component: (props) => {
        seen.push({
          source: String(props.source),
          final: props.final === true,
          messageIndex: Number(props.messageIndex),
          sessionId: props.sessionId as string | null,
        });
        return createElement('i', { 'data-source': String(props.source) });
      },
    });
    registerPluginSlot({
      pluginId: 'c.d',
      slot: 'message.leaf',
      component: () => createElement('i', { 'data-source': 'second' }),
    });
    const html = render(SAMPLE, LEAF);
    expect(seen).toEqual([
      { source: '段落', final: true, messageIndex: 4, sessionId: 'sess' },
      { source: '标题', final: true, messageIndex: 4, sessionId: 'sess' },
      { source: '**加粗** 文本', final: true, messageIndex: 4, sessionId: 'sess' },
      { source: '有序项', final: true, messageIndex: 4, sessionId: 'sess' },
      { source: '宽松甲', final: true, messageIndex: 4, sessionId: 'sess' },
      { source: '宽松乙', final: true, messageIndex: 4, sessionId: 'sess' },
      { source: 'A', final: true, messageIndex: 4, sessionId: 'sess' },
      { source: 'B', final: true, messageIndex: 4, sessionId: 'sess' },
      { source: '单元格', final: true, messageIndex: 4, sessionId: 'sess' },
      { source: '二', final: true, messageIndex: 4, sessionId: 'sess' },
      { source: '引用文字', final: true, messageIndex: 4, sessionId: 'sess' },
      { source: '四级', final: true, messageIndex: 4, sessionId: 'sess' },
    ]);
    expect(html).not.toContain('data-source="second"');
    expect(html).not.toContain('data-source="code"');
    expect(html).toContain('code');
    expect(html).toMatch(/<p[^>]*>段落<\/p><div[^>]*>/);
    expect(html).toMatch(/<h2[^>]*>标题<\/h2><div[^>]*>/);
    expect(html).toMatch(/<td[^>]*>单元格<div[^>]*>/);
    const tight = html.slice(html.indexOf('<li'), html.indexOf('</li>') + 5);
    expect(tight).toContain('<strong>加粗</strong>');
    expect(tight).toContain('data-source="**加粗** 文本"');
    expect(tight.indexOf('<strong>')).toBeLessThan(tight.indexOf('data-source'));
    expect(tight.endsWith('</li>')).toBe(true);
    const loose = html.slice(html.indexOf('宽松甲'), html.indexOf('宽松乙') + 10);
    expect(loose.match(/data-source="宽松甲"/g)).toHaveLength(1);
  });

  it('紧凑列表的嵌套列表前插入，source 不含列表标记', () => {
    registerPluginSlot({
      pluginId: 'a.b',
      slot: 'message.leaf',
      component: (props) => createElement('i', { 'data-source': String(props.source) }),
    });
    const html = render('- parent\n  - child', LEAF);
    const parent = html.indexOf('>parent');
    const parentSlot = html.indexOf('data-source="parent"');
    const child = html.indexOf('>child');
    const childSlot = html.indexOf('data-source="child"');
    expect(parent).toBeGreaterThan(-1);
    expect(parent).toBeLessThan(parentSlot);
    expect(parentSlot).toBeLessThan(child);
    expect(child).toBeLessThan(childSlot);
  });

  it('streaming 时只有写到文末的叶子 final 为 false', () => {
    const seen: { source: string; final: boolean }[] = [];
    registerPluginSlot({
      pluginId: 'a.b',
      slot: 'message.leaf',
      component: (props) => {
        seen.push({ source: String(props.source), final: props.final === true });
        return null;
      },
    });
    render('第一段\n\n第二段', LEAF, true);
    expect(seen).toEqual([
      { source: '第一段', final: true },
      { source: '第二段', final: false },
    ]);
    seen.length = 0;
    render('| A | B |\n| - | - |\n| 单元格 | 二 |', LEAF, true);
    expect(seen.map((item) => item.final)).toEqual([true, true, true, false]);
    seen.length = 0;
    render('已完成\n\n```\ncode\n```', LEAF, true);
    expect(seen).toEqual([{ source: '已完成', final: true }]);
  });

  it('插件返回 null 或抛错时原文仍在，译文 Markdown 不再进入 message.leaf', async () => {
    const seen: string[] = [];
    registerPluginSlot({
      pluginId: 'a.b',
      slot: 'message.leaf',
      component: (props) => {
        const source = String(props.source);
        seen.push(source);
        if (source === '坏') throw new Error('叶子失败');
        if (source === '空') return null;
        const View = props.Markdown as (p: { text: string }) => ReactNode;
        return createElement(View, { text: '译文 **粗**' });
      },
    });
    const html = render('原文\n\n空', LEAF);
    expect(seen).toEqual(['原文', '空']);
    expect(html).toContain('原文');
    expect(html).toContain('空');
    expect(html).toContain('<strong>粗</strong>');
    expect(seen).not.toContain('译文 **粗**');

    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const view = await renderClient(createElement(Markdown, { text: '好\n\n坏', leaf: LEAF }));
    try {
      expect(view.container.textContent).toContain('好');
      expect(view.container.textContent).toContain('坏');
      expect(view.container.textContent).not.toContain('叶子失败');
      expect(spy).toHaveBeenCalled();
    } finally {
      await view.unmount();
      spy.mockRestore();
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
