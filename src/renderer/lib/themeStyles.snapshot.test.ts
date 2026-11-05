import type { ExtensionPluginSummary } from '@shared/extensionPlugins/types';
import { BUILTIN_THEMES } from '@shared/theme/builtinThemes';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SETTINGS_VERSION } from '@/stores/settings/migrate';

// 完整模式下设置与插件主题都要经隧道读，读完之前用上次落下的主题快照，避免先闪回 enso
type FakeStyle = { id: string; textContent: string };
const head: FakeStyle[] = [];
const documentElement = {
  lang: 'en',
  dataset: {} as Record<string, string>,
  classList: { toggle: vi.fn() },
  style: { setProperty: vi.fn(), removeProperty: vi.fn() },
};
const local = new Map<string, string>();

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

const palette = (surface: string) => ({ ...BUILTIN_THEMES[0].light, surface });
const pluginFiles: Record<string, string> = {
  'nord.json': JSON.stringify({ light: palette('#eceff4'), dark: palette('#3b4252') }),
  'nord.css': '[data-enso="composer"]{border-radius:4px}',
};
const nordPlugin: Partial<ExtensionPluginSummary> = {
  id: 'acme.themes',
  name: 'Acme',
  build: 'b1',
  state: 'enabled',
  themes: [{ id: 'nord', name: 'Nord', path: 'nord.json', css: 'nord.css' }],
};

let settingsRead = deferred<unknown>();
let pluginsList = deferred<Partial<ExtensionPluginSummary>[]>();

vi.stubGlobal('navigator', { language: 'en-US' });
vi.stubGlobal('localStorage', {
  getItem: (key: string) => local.get(key) ?? null,
  setItem: (key: string, value: string) => local.set(key, value),
  removeItem: (key: string) => local.delete(key),
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
      read: vi.fn(() => settingsRead.promise),
      writeKey: vi.fn(async () => true),
      onChanged: vi.fn(),
    },
    sourceAuthority: {
      read: vi.fn(async () => ({ projects: [], conversations: [] })),
      onChanged: vi.fn(() => vi.fn()),
    },
    instructions: { delete: vi.fn(async () => ({ ok: true })) },
    extensionPlugins: {
      list: vi.fn(() => pluginsList.promise),
      onChanged: () => () => {},
      asset: vi.fn(async (_pluginId: string, rel: string) =>
        rel in pluginFiles
          ? { ok: true, mime: 'text/plain', base64: btoa(pluginFiles[rel]) }
          : { ok: false, error: '资源不存在' }
      ),
    },
    appearance: { readUserCss: vi.fn(async () => null), onUserCssChanged: () => () => {} },
  },
});

const SNAPSHOT_KEY = 'enso-theme-snapshot';
const nordSnapshot = { id: 'acme.themes/nord', tokens: ':root{--cached:1}', css: 'a{}' };
const slot = (id: string) => head.find((style) => style.id === id)?.textContent ?? '';
const settle = () => new Promise((resolve) => setTimeout(resolve, 10));
const persisted = (state: Record<string, unknown>) => ({
  'enso-settings': { state, version: SETTINGS_VERSION },
});

async function install() {
  vi.resetModules();
  const { installThemeStyles } = await import('./themeStyles');
  installThemeStyles();
}

describe('theme snapshot', () => {
  beforeEach(() => {
    head.length = 0;
    documentElement.dataset = {};
    local.clear();
    settingsRead = deferred();
    pluginsList = deferred();
  });

  it('设置和插件主题都没读到时沿用快照，插件主题到了再换成实时结果并更新快照', async () => {
    local.set(SNAPSHOT_KEY, JSON.stringify(nordSnapshot));
    await install();
    expect(documentElement.dataset.theme).toBe('acme.themes/nord');
    expect(slot('enso-theme-tokens')).toBe(nordSnapshot.tokens);
    expect(slot('enso-theme-css')).toBe(nordSnapshot.css);

    settingsRead.resolve(persisted({ themeId: 'acme.themes/nord' }));
    await settle();
    expect(slot('enso-theme-tokens')).toBe(nordSnapshot.tokens);

    pluginsList.resolve([nordPlugin]);
    await settle();
    expect(slot('enso-theme-tokens')).toContain('--background: #eceff4;');
    expect(slot('enso-theme-css')).toBe(pluginFiles['nord.css']);
    expect(JSON.parse(local.get(SNAPSHOT_KEY) ?? '{}')).toEqual({
      id: 'acme.themes/nord',
      tokens: slot('enso-theme-tokens'),
      css: pluginFiles['nord.css'],
    });
  });

  it('水合后的主题与快照不同（含仍是默认 enso）时以设置为准', async () => {
    local.set(SNAPSHOT_KEY, JSON.stringify(nordSnapshot));
    await install();
    settingsRead.resolve(persisted({}));
    await settle();
    expect(documentElement.dataset.theme).toBe('enso');
    expect(slot('enso-theme-css')).toBe('');
    expect(JSON.parse(local.get(SNAPSHOT_KEY) ?? '{}').id).toBe('enso');
  });

  it('没有快照或快照损坏时首帧按默认 enso 渲染', async () => {
    local.set(SNAPSHOT_KEY, '{oops');
    await install();
    expect(documentElement.dataset.theme).toBe('enso');
    expect(slot('enso-theme-tokens')).toContain(`--brand: ${BUILTIN_THEMES[0].light.accent};`);
  });
});
