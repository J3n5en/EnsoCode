import { describe, expect, it } from 'vitest';
import {
  CHAT_TYPOGRAPHY_ROLES,
  type ChatTypography,
  chatTypographyCssVars,
  DEFAULT_CHAT_TYPOGRAPHY,
  normalizeChatTypography,
} from './chatTypography';

const EXPECTED_DEFAULT: ChatTypography = {
  body: { size: 14, weight: 400 },
  h1: { size: 130, weight: 600 },
  h2: { size: 115, weight: 600 },
  h3: { size: 105, weight: 600 },
  h4: { size: 100, weight: 600 },
  table: { size: 90, weight: 400 },
  inlineCode: { size: 85, weight: 400 },
  codeBlock: { size: 12, weight: 400 },
};

describe('chatTypography', () => {
  it('默认值与当前渲染一致', () => {
    expect(DEFAULT_CHAT_TYPOGRAPHY).toEqual(EXPECTED_DEFAULT);
    expect(normalizeChatTypography(undefined)).toEqual(EXPECTED_DEFAULT);
  });

  it.each([null, [], '14.5', 14.5])('脏输入 %j 整表回退默认', (value) => {
    expect(normalizeChatTypography(value)).toEqual(EXPECTED_DEFAULT);
  });

  it('字符串 size、NaN 与未知字重回该元素默认，其余字段保留', () => {
    const next = normalizeChatTypography({
      body: { size: '18', weight: 500 },
      h1: { size: Number.NaN, weight: 700 },
      h2: { size: 140, weight: 'semibold' },
      codeBlock: { size: 12, weight: 800 },
    });
    expect(next.body).toEqual({ size: 14, weight: 500 });
    expect(next.h1).toEqual({ size: 130, weight: 700 });
    expect(next.h2).toEqual({ size: 140, weight: 600 });
    expect(next.codeBlock).toEqual({ size: 12, weight: 400 });
  });

  it('越界夹回，非 step 对齐，缺失元素补默认', () => {
    const next = normalizeChatTypography({
      body: { size: 99, weight: 300 },
      h1: { size: 112, weight: 500 },
      h4: { size: 50, weight: 600 },
      inlineCode: { size: 83, weight: 400 },
      codeBlock: { size: 8, weight: 400 },
    });
    expect(next.body).toEqual({ size: 20, weight: 300 });
    expect(next.h1).toEqual({ size: 110, weight: 500 });
    expect(next.h4).toEqual({ size: 80, weight: 600 });
    expect(next.inlineCode).toEqual({ size: 85, weight: 400 });
    expect(next.codeBlock).toEqual({ size: 9, weight: 400 });
    expect(next.h2).toEqual(EXPECTED_DEFAULT.h2);
    expect(next.h3).toEqual(EXPECTED_DEFAULT.h3);
    expect(next.table).toEqual(EXPECTED_DEFAULT.table);
    expect(Object.keys(next)).toEqual([...CHAT_TYPOGRAPHY_ROLES]);
  });

  it('百分数字号输出 em，像素字号输出 px', () => {
    const vars = chatTypographyCssVars(
      normalizeChatTypography({
        body: { size: 16, weight: 300 },
        h1: { size: 200, weight: 700 },
        h3: { size: 115, weight: 600 },
        h4: { size: 100, weight: 600 },
        table: { size: 90, weight: 400 },
        inlineCode: { size: 85, weight: 500 },
        codeBlock: { size: 10.5, weight: 400 },
      })
    );
    expect(vars['--chat-body-size']).toBe('16px');
    expect(vars['--chat-body-weight']).toBe('300');
    expect(vars['--chat-h1-size']).toBe('2em');
    expect(vars['--chat-h1-weight']).toBe('700');
    expect(vars['--chat-h2-size']).toBe('1.15em');
    expect(vars['--chat-h3-size']).toBe('1.15em');
    expect(vars['--chat-h4-size']).toBe('1em');
    expect(vars['--chat-table-size']).toBe('0.9em');
    expect(vars['--chat-inline-code-size']).toBe('0.85em');
    expect(vars['--chat-inline-code-weight']).toBe('500');
    expect(vars['--chat-code-block-size']).toBe('10.5px');
    expect(vars['--chat-code-block-weight']).toBe('400');
  });
});
