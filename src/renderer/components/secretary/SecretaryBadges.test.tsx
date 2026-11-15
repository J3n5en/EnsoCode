import { type Locale, translate } from '@shared/i18n';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { SecretaryOriginBadge } from './SecretaryOriginBadge';
import { SecretaryTakeoverBadge, SecretaryTakeoverControl } from './SecretaryTakeover';

const h = vi.hoisted(() => ({
  name: '',
  locale: 'zh' as Locale,
  takeovers: [] as { conversationId: string }[],
}));

vi.mock('@/i18n', () => ({
  useI18n: () => ({
    t: (key: string, params?: Record<string, string | number>) => translate(h.locale, key, params),
    locale: h.locale,
  }),
}));
vi.mock('@/stores/secretary', () => ({
  useSecretaryStore: (select: (state: object) => unknown) =>
    select({ secretary: { profile: { name: h.name }, takeovers: h.takeovers } }),
}));
vi.mock('@/stores/sessions', () => ({ useSessionsStore: () => null }));
vi.mock('@/stores/settings', () => ({ useSettingsStore: () => undefined }));

const render = (component: typeof SecretaryOriginBadge) =>
  renderToStaticMarkup(createElement(component)).replace(/<[^>]*>/g, '');

describe('秘书会话标识用昵称', () => {
  it('显示用户改的名字', () => {
    h.name = '爱酱';
    h.locale = 'zh';
    expect(render(SecretaryOriginBadge)).toBe('由爱酱派出');
    expect(render(SecretaryTakeoverBadge)).toBe('爱酱接管中');
  });

  it('没设名字时回退到「秘书」', () => {
    h.name = '  ';
    h.locale = 'zh';
    expect(render(SecretaryOriginBadge)).toBe('由秘书派出');
    expect(render(SecretaryTakeoverBadge)).toBe('秘书接管中');
  });

  it('英文界面同样带名字', () => {
    h.name = 'Ai';
    h.locale = 'en';
    expect(render(SecretaryOriginBadge)).toBe('Dispatched by Ai');
    expect(render(SecretaryTakeoverBadge)).toBe('Managed by Ai');
  });
});

describe('会话顶栏不再给「交给…接管」按钮', () => {
  const control = (conversationId: string) =>
    renderToStaticMarkup(createElement(SecretaryTakeoverControl, { conversationId }));

  it('未接管时什么都不渲染，逐个授权只走秘书提的确认卡', () => {
    h.name = '爱酱';
    h.locale = 'zh';
    h.takeovers = [];
    expect(control('c1')).toBe('');
    expect(control('c1')).not.toContain('secretary-takeover-grant');
    expect(control('c1')).not.toContain('交给爱酱接管');
  });

  it('接管中仍显示标识与取消按钮', () => {
    h.name = '爱酱';
    h.locale = 'zh';
    h.takeovers = [{ conversationId: 'c1' }];
    const html = control('c1');
    expect(html).toContain('secretary-takeover-chip');
    expect(html).toContain('secretary-takeover-revoke');
    expect(html).toContain('爱酱接管中');
    // 别的会话不受影响
    expect(control('c2')).toBe('');
  });
});
