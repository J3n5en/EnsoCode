import { parseHTML } from 'linkedom';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { AskBar } from './AskBar';
import {
  askFocusMove,
  askFocusStart,
  askOptionShortcut,
  askOptionShortcutCount,
} from './askOptions';

vi.mock('@/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));

const ask = {
  requestId: 'q',
  question: 'Which?',
  options: ['Keep it', 'Drop it'],
};
const render = (asks: unknown[], props?: Record<string, unknown>) =>
  renderToStaticMarkup(
    createElement(AskBar, { asks: asks as never, onAnswer: () => {}, ...props })
  );

describe('提问选项快捷键', () => {
  it('前 9 个选项对应 1-9，第 10 个没有', () => {
    expect(askOptionShortcut(0)).toBe('1');
    expect(askOptionShortcut(8)).toBe('9');
    expect(askOptionShortcut(9)).toBeNull();
    expect(askOptionShortcutCount(['a', 'b', 'c'])).toBe(3);
  });
});

describe('提问条键盘焦点', () => {
  it('打开时落在推荐项，没有推荐落第一项，没有选项落输入框', () => {
    expect(askFocusStart(['a', 'b'], 'b')).toBe(1);
    expect(askFocusStart(['a', 'b'], undefined)).toBe(0);
    expect(askFocusStart(undefined, undefined)).toBe(0);
    expect(askFocusStart([], undefined)).toBe(0);
  });

  it('↑↓ 在选项与末尾输入框之间移动，到头不循环；其它键不动', () => {
    // 两个选项 + 输入框 = 3 个位置
    expect(askFocusMove(0, 3, 'ArrowDown')).toBe(1);
    expect(askFocusMove(1, 3, 'ArrowDown')).toBe(2);
    expect(askFocusMove(2, 3, 'ArrowDown')).toBe(2);
    expect(askFocusMove(2, 3, 'ArrowUp')).toBe(1);
    expect(askFocusMove(0, 3, 'ArrowUp')).toBe(0);
    expect(askFocusMove(1, 3, 'Tab')).toBeNull();
  });
});

describe('AskBar', () => {
  it('每个选项带序号，推荐标在 recommended 指定的那一项', () => {
    const html = render([{ ...ask, recommended: 'Drop it' }]);
    expect(html).toContain('>1<');
    expect(html).toContain('>2<');
    expect(html).toContain('>Keep it<');
    expect(html).toContain('>Recommended<');
    expect(html.indexOf('>Recommended<')).toBeGreaterThan(html.indexOf('>Drop it<'));
  });

  it('没有指定推荐或没有选项时不标推荐', () => {
    expect(render([ask])).not.toContain('Recommended');
    expect(render([{ requestId: 'q', question: 'Why?' }])).not.toContain('Recommended');
  });

  it('多于一个提问时显示 1/N', () => {
    expect(render([ask, { ...ask, requestId: 'q2' }])).toContain('>1/2<');
  });

  it('长正文限高并在自身内部滚动，标题行、选项、输入框不在正文滚动区里', () => {
    const question = Array.from({ length: 30 }, (_, i) => `第 ${i + 1} 行`).join('\n');
    const options = ['甲', '乙', '丙'];
    const { document } = parseHTML(
      render([{ ...ask, question, options, relay: { name: '爱酱' } }])
    );
    const card = document.querySelector('[data-enso="ask"]');
    const body = document.querySelector('[data-enso="ask-question"]');
    const optionList = document.querySelector('[data-enso="ask-options"]');
    expect(card?.className).toMatch(/(^|\s)max-h-\[/);
    expect(body?.textContent).toBe(question);
    expect(body?.className.split(/\s+/)).toEqual(
      expect.arrayContaining(['overflow-y-auto', 'overscroll-contain', 'min-w-0'])
    );
    expect(optionList?.className.split(/\s+/)).toEqual(
      expect.arrayContaining(['shrink-0', 'overflow-y-auto', 'overscroll-contain'])
    );
    expect(optionList?.className).toMatch(/(^|\s)max-h-\[/);
    const optionButtons = [...(optionList?.querySelectorAll('button') ?? [])];
    expect(optionButtons.map((button) => button.textContent)).toEqual(['1甲', '2乙', '3丙']);
    const input = card?.querySelector('input');
    expect(input).toBeTruthy();
    expect(input?.parentElement?.className.split(/\s+/)).toContain('shrink-0');
    for (const kept of [
      input,
      optionList,
      document.querySelector('[data-enso="ask-relay"]'),
      ...optionButtons,
    ]) {
      expect(kept && body?.contains(kept)).toBe(false);
    }
  });
});
