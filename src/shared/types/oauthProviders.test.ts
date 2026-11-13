import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  OAUTH_LABEL_MAX_LENGTH,
  type OauthLoginPrompt,
  sanitizeOauthLabel,
} from './oauthProviders';

describe('OauthLoginPrompt 契约', () => {
  // 真实场景：Qoder 的 PAT 提示声明 allowEmpty，留空才走浏览器登录；契约缺这个字段，Main 无法把声明带给界面
  it('登录提示可以声明允许留空提交', () => {
    expectTypeOf<OauthLoginPrompt>()
      .toHaveProperty('allowEmpty')
      .toEqualTypeOf<boolean | undefined>();
  });
});

describe('sanitizeOauthLabel', () => {
  it('短文案原样返回', () => {
    expect(sanitizeOauthLabel('plus')).toBe('plus');
    expect(sanitizeOauthLabel('Anthropic Weekly')).toBe('Anthropic Weekly');
  });

  it('去掉控制字符并 trim', () => {
    expect(sanitizeOauthLabel('\u0000plus\u0007\n')).toBe('plus');
    expect(sanitizeOauthLabel('  pro  ')).toBe('pro');
    expect(sanitizeOauthLabel('\u007f\t')).toBe('');
  });

  it(`超长厂商串硬截到 ${OAUTH_LABEL_MAX_LENGTH}，不加省略号`, () => {
    const raw = 'P'.repeat(OAUTH_LABEL_MAX_LENGTH + 40);
    const capped = sanitizeOauthLabel(raw);
    expect(capped).toHaveLength(OAUTH_LABEL_MAX_LENGTH);
    expect(capped).toBe('P'.repeat(OAUTH_LABEL_MAX_LENGTH));
    expect(capped).not.toContain('…');
  });

  it('刚好等于上限的串不截', () => {
    const exact = 'E'.repeat(OAUTH_LABEL_MAX_LENGTH);
    expect(sanitizeOauthLabel(exact)).toBe(exact);
  });
});
