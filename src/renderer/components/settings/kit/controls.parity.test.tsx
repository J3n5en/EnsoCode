import { createElement, type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectTrigger, SelectValue } from '@/components/ui/select';
import { SettingsButton, SettingsInput, SettingsPage, SettingsSelect } from '.';

vi.mock('@/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));

const classOf = (node: ReactElement, slot: string) => {
  const html = renderToStaticMarkup(node);
  const match = html.match(new RegExp(`<[^>]*data-slot="${slot}"[^>]*>`));
  expect(match, slot).not.toBeNull();
  return (match?.[0].match(/class="([^"]*)"/)?.[1] ?? '').split(/\s+/).filter(Boolean);
};

/** kit 控件相对主界面同尺寸 ui 控件多出来的类：只允许宽度和窄屏触屏的调整，不许改高度、圆角、字号 */
const extras = (kit: string[], ui: string[]) => kit.filter((token) => !ui.includes(token));
const ALLOWED = /^(w-\[\d+px\]|max-w-full|max-sm:.*)$/;

describe('设置 kit 控件与主界面 ui 控件同一套尺寸', () => {
  it('按钮就是 ui Button 的 sm 描边款，主按钮是 sm 默认款', () => {
    const ui = classOf(createElement(Button, { size: 'sm', variant: 'outline' }, 'x'), 'button');
    expect(classOf(createElement(SettingsButton, null, 'x'), 'button')).toEqual(ui);
    const primary = classOf(createElement(Button, { size: 'sm' }, 'x'), 'button');
    expect(classOf(createElement(SettingsButton, { variant: 'default' }, 'x'), 'button')).toEqual(
      primary
    );
  });

  it('下拉就是 ui SelectTrigger 的 sm 款，只多宽度', () => {
    const ui = classOf(
      createElement(
        Select,
        { value: 'a', items: { a: 'A' } },
        createElement(SelectTrigger, { size: 'sm' }, createElement(SelectValue))
      ),
      'select-trigger'
    );
    const kit = classOf(
      createElement(SettingsSelect, {
        value: 'a',
        onValueChange: () => {},
        options: [{ value: 'a', label: 'A' }],
      }),
      'select-trigger'
    );
    expect(extras(kit, ui).filter((token) => !ALLOWED.test(token))).toEqual([]);
  });

  it('输入框就是 ui Input 的 sm 款，桌面端不改高度', () => {
    const ui = classOf(createElement(Input, { size: 'sm' }), 'input');
    const kit = classOf(createElement(SettingsInput, { value: '', onCommit: () => {} }), 'input');
    expect(kit).toEqual(ui);
    const wrapUi = classOf(createElement(Input, { size: 'sm' }), 'input-control');
    const wrapKit = classOf(
      createElement(SettingsInput, { value: '', onCommit: () => {} }),
      'input-control'
    );
    expect(extras(wrapKit, wrapUi).filter((token) => !ALLOWED.test(token))).toEqual([]);
  });
});

describe('SettingsPage 页头', () => {
  const header = () =>
    renderToStaticMarkup(
      createElement(SettingsPage, {
        title: '模型中心',
        badge: createElement('span', { 'data-badge': '' }, '新会话生效'),
        description: '管理应用的模型 API 服务',
        actions: createElement('button', { type: 'button' }, 'a'),
      })
    );

  it('标题区有不小于 240px 的最小宽度，操作按钮放不下时整体换到下一行而不是挤压标题', () => {
    const html = header();
    const titleBlock = html.match(/<header[^>]*><div class="([^"]*)"/)?.[1].split(' ') ?? [];
    expect(titleBlock).not.toContain('min-w-0');
    const minWidth = titleBlock.join(' ').match(/min-w-\[min\(100%,(\d+)px\)\]/)?.[1];
    expect(Number(minWidth)).toBeGreaterThanOrEqual(240);
    const basis = titleBlock.join(' ').match(/basis-\[(\d+)px\]/)?.[1];
    expect(Number(basis)).toBe(Number(minWidth));
    expect(html).toMatch(/<header[^>]*class="[^"]*flex-wrap/);
  });

  it('标签和标题按基线对齐', () => {
    expect(header()).toMatch(/<h1 class="[^"]*items-baseline[^"]*">模型中心<span data-badge/);
  });
});
