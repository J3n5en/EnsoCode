import { ACCENT_PRESETS } from '@shared/accentColor';
import { BUILTIN_THEMES } from '@shared/theme/builtinThemes';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import type * as SettingsModule from '@/stores/settings';
import { mergeSettingsState } from '@/stores/settings/migrate';
import type * as ThemeStylesModule from './themeStyles';

type FakeStyle = { id: string; textContent: string };
const head: FakeStyle[] = [];
const documentElement = {
  lang: 'en',
  dataset: {} as Record<string, string>,
  classList: { toggle: vi.fn() },
  style: { setProperty: vi.fn(), removeProperty: vi.fn() },
};

vi.stubGlobal('navigator', { language: 'en-US' });
let userCss: string | null = null;
let notifyUserCssChanged = () => {};
const readUserCss = vi.fn(async () => userCss);
vi.stubGlobal('document', {
  documentElement,
  head: { append: (style: FakeStyle) => head.push(style) },
  createElement: (): FakeStyle => ({ id: '', textContent: '' }),
  getElementById: (id: string) => head.find((style) => style.id === id) ?? null,
});
vi.stubGlobal('window', {
  matchMedia: () => ({ matches: false, addEventListener: vi.fn() }),
  electronAPI: {
    settings: {
      read: vi.fn(async () => null),
      writeKey: vi.fn(async () => true),
      onChanged: vi.fn(),
    },
    sourceAuthority: {
      read: vi.fn(async () => ({ projects: [], conversations: [] })),
      onChanged: vi.fn(() => vi.fn()),
    },
    instructions: { delete: vi.fn(async () => ({ ok: true })) },
    appearance: {
      readUserCss,
      onUserCssChanged: (callback: () => void) => {
        notifyUserCssChanged = callback;
        return () => {};
      },
    },
  },
});

let settings: typeof SettingsModule;
let themeStyles: typeof ThemeStylesModule;
const tokens = () => head.find((style) => style.id === 'enso-theme-tokens')?.textContent ?? '';
const userCssSlot = () => head.find((style) => style.id === 'enso-user-css')?.textContent ?? '';
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('theme styles', () => {
  beforeAll(async () => {
    settings = await import('@/stores/settings');
    themeStyles = await import('./themeStyles');
  });

  it('安装时同步写入 Enso 主题 token，并按顺序预留主题 CSS 与用户 CSS', () => {
    expect(settings.useSettingsStore.getState()).toMatchObject({
      themeId: 'enso',
      accentColor: 'theme',
      userCssEnabled: false,
    });
    themeStyles.installThemeStyles();
    expect(head.map((style) => style.id)).toEqual([
      'enso-theme-tokens',
      'enso-theme-css',
      'enso-user-css',
    ]);
    expect(documentElement.dataset.theme).toBe('enso');
    expect(tokens()).toContain(`--brand: ${BUILTIN_THEMES[0].light.accent};`);
  });

  it('切换强调色与主题时重写 token，不可用的插件主题按 enso 渲染但保留设置', () => {
    settings.useSettingsStore.getState().setAccentColor('teal');
    expect(tokens()).toContain(`--brand: ${ACCENT_PRESETS.teal.dark};`);
    settings.useSettingsStore.getState().setThemeId('paper');
    expect(documentElement.dataset.theme).toBe('paper');
    expect(tokens()).toContain(`--background: ${BUILTIN_THEMES[2].light.surface};`);
    settings.useSettingsStore.getState().setThemeId('acme.themes/nord');
    expect(settings.useSettingsStore.getState().themeId).toBe('acme.themes/nord');
    expect(documentElement.dataset.theme).toBe('enso');
  });

  it('主题 CSS 与用户 CSS 写入各自的样式槽', () => {
    themeStyles.applyThemeCss('a{}');
    themeStyles.applyUserCss('b{}');
    expect(head.map((style) => style.textContent).slice(1)).toEqual(['a{}', 'b{}']);
  });

  it('用户 CSS 只在开关打开时注入，文件变化实时生效，关掉即清空', async () => {
    themeStyles.applyUserCss('');
    userCss = '[data-enso="composer"]{outline:2px solid red}';
    notifyUserCssChanged();
    await settle();
    expect(userCssSlot()).toBe('');

    settings.useSettingsStore.getState().setUserCssEnabled(true);
    await settle();
    expect(userCssSlot()).toBe(userCss);

    userCss = 'a{color:red}';
    notifyUserCssChanged();
    await settle();
    expect(userCssSlot()).toBe('a{color:red}');

    userCss = null;
    notifyUserCssChanged();
    await settle();
    expect(userCssSlot()).toBe('');

    userCss = 'b{}';
    notifyUserCssChanged();
    settings.useSettingsStore.getState().setUserCssEnabled(false);
    await settle();
    expect(userCssSlot()).toBe('');
  });

  it('持久化里的非法强调色合并时落回默认值', () => {
    const current = { editMode: 'apply_patch' as const, accentColor: 'theme' as const };
    expect(mergeSettingsState({ accentColor: 'neon' }, current).accentColor).toBe('theme');
    expect(mergeSettingsState({ accentColor: 'amber' }, current).accentColor).toBe('amber');
    expect(mergeSettingsState({}, current).accentColor).toBe('theme');
  });
});
