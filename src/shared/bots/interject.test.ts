import { describe, expect, it } from 'vitest';
import { stripInterjection, wrapInterjection } from './interject';

describe('wrapInterjection', () => {
  it('按界面语言在插话前加补充说明', () => {
    expect(wrapInterjection('顺便加个测试', 'zh')).toBe(
      '这是同一件事的补充，保留原目标，把它并进这一轮的结果；不要单独回一句「收到」。只有明确说换掉或取消才改目标。\n补充内容：\n顺便加个测试'
    );
    const en = wrapInterjection('also add a test', 'en');
    expect(en.startsWith('This adds to the same request.')).toBe(true);
    expect(en.endsWith('\nAddition:\nalso add a test')).toBe(true);
  });

  it('剥离与包装互逆，只认开头的说明', () => {
    for (const lang of ['zh', 'en'] as const)
      expect(stripInterjection(wrapInterjection('a\nb', lang))).toBe('a\nb');
    expect(stripInterjection('plain')).toBe('plain');
    const inner = `x ${wrapInterjection('y', 'zh')}`;
    expect(stripInterjection(inner)).toBe(inner);
  });
});
