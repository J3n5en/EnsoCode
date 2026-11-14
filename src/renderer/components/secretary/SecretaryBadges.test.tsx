import { type Locale, translate } from '@shared/i18n';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { SecretaryOriginBadge } from './SecretaryOriginBadge';
import { SecretaryTakeoverBadge } from './SecretaryTakeover';

const h = vi.hoisted(() => ({ name: '', locale: 'zh' as Locale }));

vi.mock('@/i18n', () => ({
  useI18n: () => ({
    t: (key: string, params?: Record<string, string | number>) => translate(h.locale, key, params),
    locale: h.locale,
  }),
}));
vi.mock('@/stores/secretary', () => ({
  useSecretaryStore: (select: (state: object) => unknown) =>
    select({ secretary: { profile: { name: h.name } } }),
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
