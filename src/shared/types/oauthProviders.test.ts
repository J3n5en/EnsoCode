import { describe, expect, it } from 'vitest';
import { OAUTH_LABEL_MAX_LENGTH, sanitizeOauthLabel } from './oauthProviders';

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
