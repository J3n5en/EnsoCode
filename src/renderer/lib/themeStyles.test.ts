import { ACCENT_PRESETS } from '@shared/accentColor';
import type { ExtensionPluginSummary } from '@shared/extensionPlugins/types';
import { BUILTIN_THEMES } from '@shared/theme/builtinThemes';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import type * as PluginThemesModule from '@/stores/pluginThemes';
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

const palette = (surface: string) => ({
  ...BUILTIN_THEMES[0].light,
  surface,
});
const pluginFiles: Record<string, string> = {
  'nord.json': JSON.stringify({ light: palette('#eceff4'), dark: palette('#3b4252') }),
  'nord.css': '[data-enso="composer"]{border-radius:4px}',
  'broken.json': JSON.stringify({ light: palette('#fff') }),
};
let plugins: Partial<ExtensionPluginSummary>[] = [];
let notifyPluginsChanged = () => {};
const themePlugin = (state: ExtensionPluginSummary['state']): Partial<ExtensionPluginSummary> => ({
  id: 'acme.themes',
  name: 'Acme',
  build: 'b1',
  state,
  themes: [
    { id: 'nord', name: 'Nord', path: 'nord.json', css: 'nord.css' },
    { id: 'broken', name: 'Broken', path: 'broken.json' },
  ],
});
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
    extensionPlugins: {
      list: vi.fn(async () => plugins),
      onChanged: (callback: () => void) => {
        notifyPluginsChanged = callback;
        return () => {};
      },
      asset: vi.fn(async (_pluginId: string, rel: string) =>
        rel in pluginFiles
          ? { ok: true, mime: 'text/plain', base64: btoa(pluginFiles[rel]) }
          : { ok: false, error: '资源不存在' }
      ),
    },
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
let pluginThemes: typeof PluginThemesModule;
const tokens = () => head.find((style) => style.id === 'enso-theme-tokens')?.textContent ?? '';
const themeCssSlot = () => head.find((style) => style.id === 'enso-theme-css')?.textContent ?? '';
const userCssSlot = () => head.find((style) => style.id === 'enso-user-css')?.textContent ?? '';
const settle = () => new Promise((resolve) => setTimeout(resolve, 10));

describe('theme styles', () => {
  beforeAll(async () => {
    settings = await import('@/stores/settings');
    themeStyles = await import('./themeStyles');
    pluginThemes = await import('@/stores/pluginThemes');
  });

  it('安装时同步写入 Enso 主题 token，并按顺序预留主题 CSS 与用户 CSS', async () => {
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
    await settle();
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

  it('插件主题加载后生效并注入 CSS；停用回落 enso 不改设置，再启用自动回来', async () => {
    plugins = [themePlugin('enabled')];
    notifyPluginsChanged();
    await settle();
    expect(documentElement.dataset.theme).toBe('acme.themes/nord');
    expect(tokens()).toContain('--background: #eceff4;');
    expect(themeCssSlot()).toBe(pluginFiles['nord.css']);
    expect(themeStyles.availableThemes().map((theme) => theme.id)).toContain('acme.themes/nord');
    expect(pluginThemes.usePluginThemesStore.getState().errors['acme.themes']).toEqual([
      expect.stringMatching(/^Broken：.*dark/),
    ]);

    plugins = [themePlugin('disabled')];
    notifyPluginsChanged();
    await settle();
    expect(documentElement.dataset.theme).toBe('enso');
    expect(themeCssSlot()).toBe('');
    expect(settings.useSettingsStore.getState().themeId).toBe('acme.themes/nord');

    plugins = [themePlugin('enabled')];
    notifyPluginsChanged();
    await settle();
    expect(documentElement.dataset.theme).toBe('acme.themes/nord');
  });

  it('没同意样式能力（摘要不带 css）时只换 token，不注入 CSS', async () => {
    plugins = [
      {
        ...themePlugin('enabled'),
        build: 'b2',
        themes: [{ id: 'nord', name: 'Nord', path: 'nord.json' }],
      },
    ];
    notifyPluginsChanged();
    await settle();
    expect(tokens()).toContain('--background: #eceff4;');
    expect(themeCssSlot()).toBe('');
  });

  it('插件主题还没读完时保持上一个主题', () => {
    settings.useSettingsStore.getState().setThemeId('graphite');
    pluginThemes.usePluginThemesStore.setState({ themes: null });
    settings.useSettingsStore.getState().setThemeId('acme.themes/nord');
    expect(documentElement.dataset.theme).toBe('graphite');
  });

  it('用户 CSS 只在开关打开时注入，文件变化实时生效，关掉即清空', async () => {
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
