import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HOVER_ROW_CLASS, HoverActions, rowFinalFocus } from './hover-actions';

const classes = (html: string) => (/class="([^"]*)"/.exec(html)?.[1] ?? '').split(' ');

describe('HoverActions', () => {
  it('平时脱离文档流、不可见、点不到；只跟所在行的悬停或键盘焦点浮出', () => {
    const cls = classes(renderToStaticMarkup(<HoverActions />));
    expect(cls).toEqual(
      expect.arrayContaining([
        'absolute',
        'right-0',
        'opacity-0',
        'pointer-events-none',
        'group-hover/row:opacity-100',
        'group-hover/row:pointer-events-auto',
        'group-has-[:focus-visible]/row:opacity-100',
        'group-has-[:focus-visible]/row:pointer-events-auto',
        'bg-linear-to-l',
        'to-transparent',
      ])
    );
    // 绑定具名 group：外层别的 .group 悬停不会把每一行的按钮都带出来
    expect(cls).not.toContain('group-hover:opacity-100');
    expect(HOVER_ROW_CLASS.split(' ')).toEqual(expect.arrayContaining(['group/row', 'relative']));
  });

  it('不着色的行可以把蒙版底色换成面板底色', () => {
    const cls = classes(renderToStaticMarkup(<HoverActions className="from-background" />));
    expect(cls.filter((c) => c.startsWith('from-[') || c === 'from-background')).toEqual([
      'from-background',
    ]);
  });
});

describe('rowFinalFocus', () => {
  afterEach(() => vi.unstubAllGlobals());
  const activeVisible = (visible: boolean | null) =>
    vi.stubGlobal('document', {
      activeElement: visible === null ? null : { matches: () => visible },
    });

  it('键盘关弹窗照常把焦点还给行内按钮', () => {
    activeVisible(false);
    expect(rowFinalFocus('keyboard')).toBe(true);
  });

  it('鼠标/触摸/笔关弹窗不还焦点，免得行内操作在鼠标移开后还浮着', () => {
    activeVisible(true);
    for (const type of ['mouse', 'touch', 'pen']) expect(rowFinalFocus(type)).toBe(false);
  });

  it('外部改 open 关的（类型为空）按关闭那一刻是不是键盘可见焦点决定', () => {
    activeVisible(true);
    expect(rowFinalFocus('')).toBe(true);
    activeVisible(false);
    expect(rowFinalFocus('')).toBe(false);
    activeVisible(null);
    expect(rowFinalFocus('')).toBe(false);
  });
});
