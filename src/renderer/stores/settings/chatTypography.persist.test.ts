import { DEFAULT_CHAT_TYPOGRAPHY } from '@shared/chatTypography';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SETTINGS_VERSION } from './migrate';

let persisted: Record<string, unknown> | null = null;
const cssVars = new Map<string, string>();
const writeKey = vi.fn(async (name: string, value: unknown) => {
  persisted = { ...persisted, [name]: value };
  return true;
});

beforeEach(() => {
  vi.resetModules();
  persisted = null;
  cssVars.clear();
  writeKey.mockClear();
  vi.stubGlobal('navigator', { language: 'en-US' });
  vi.stubGlobal('document', {
    documentElement: {
      dataset: {},
      lang: 'en',
      classList: { toggle: vi.fn() },
      style: {
        setProperty: (name: string, value: string) => {
          cssVars.set(name, value);
        },
        removeProperty: (name: string) => {
          cssVars.delete(name);
        },
      },
    },
  });
  vi.stubGlobal('window', {
    matchMedia: () => ({ matches: false, addEventListener: vi.fn() }),
    electronAPI: {
      settings: {
        read: async () => persisted,
        writeKey,
        onChanged: vi.fn(),
      },
      sourceAuthority: {
        read: async () => ({ projects: [], conversations: [] }),
        onChanged: vi.fn(),
      },
    },
  });
});

async function loadStore(state: Record<string, unknown> = {}) {
  persisted = { 'enso-settings': { version: SETTINGS_VERSION, state } };
  const { useSettingsStore } = await import('./index');
  await vi.waitFor(() => expect(useSettingsStore.persist.hasHydrated()).toBe(true));
  return useSettingsStore;
}

describe('会话排版设置', () => {
  it('旧配置缺少字段时得到默认，并写上默认 CSS 变量', async () => {
    const store = await loadStore();
    expect(store.getState().chatTypography).toEqual(DEFAULT_CHAT_TYPOGRAPHY);
    expect(cssVars.get('--chat-body-size')).toBe('14.5px');
    expect(cssVars.get('--chat-h1-size')).toBe('1.5em');
    expect(cssVars.get('--chat-inline-code-size')).toBe('0.85em');
    expect(cssVars.get('--chat-code-block-size')).toBe('10.5px');
  });

  it('setter 写入后经持久化重载能恢复，恢复默认回到规格', async () => {
    const store = await loadStore();
    const next = {
      ...DEFAULT_CHAT_TYPOGRAPHY,
      body: { size: 16, weight: 500 as const },
      h1: { size: 200, weight: 700 as const },
    };
    expect(store.getState().setChatTypography).toBeTypeOf('function');
    store.getState().setChatTypography(next);
    expect(store.getState().chatTypography).toEqual(next);
    expect(cssVars.get('--chat-body-size')).toBe('16px');
    expect(cssVars.get('--chat-body-weight')).toBe('500');
    expect(cssVars.get('--chat-h1-size')).toBe('2em');
    expect(persisted).toMatchObject({
      'enso-settings': { state: { chatTypography: next } },
    });
    const saved = persisted;
    store.setState({ chatTypography: DEFAULT_CHAT_TYPOGRAPHY });
    persisted = saved;
    await store.persist.rehydrate();
    expect(store.getState().chatTypography).toEqual(next);

    store.getState().resetChatTypography();
    expect(store.getState().chatTypography).toEqual(DEFAULT_CHAT_TYPOGRAPHY);
    expect(cssVars.get('--chat-body-size')).toBe('14.5px');
    expect(cssVars.get('--chat-h1-size')).toBe('1.5em');
  });

  it('持久化的脏值被规范化后再进入内存和 CSS 变量', async () => {
    const store = await loadStore({
      chatTypography: {
        body: { size: 99, weight: 450 },
        h1: { size: '120', weight: 700 },
        h2: { size: 112, weight: 500 },
      },
    });
    expect(store.getState().chatTypography.body).toEqual({ size: 20, weight: 400 });
    expect(store.getState().chatTypography.h1).toEqual({ size: 150, weight: 700 });
    expect(store.getState().chatTypography.h2).toEqual({ size: 110, weight: 500 });
    expect(store.getState().chatTypography.table).toEqual(DEFAULT_CHAT_TYPOGRAPHY.table);
    expect(cssVars.get('--chat-body-size')).toBe('20px');
    expect(cssVars.get('--chat-h2-size')).toBe('1.1em');
  });

  it('绕过 setter 写入的脏值在落盘前被规范化', async () => {
    const store = await loadStore();
    store.setState({
      chatTypography: { body: { size: 13.2, weight: 450 } } as never,
    });
    const saved = persisted?.['enso-settings'] as { state?: { chatTypography?: unknown } };
    expect(saved.state?.chatTypography).toMatchObject({
      body: { size: 13, weight: 400 },
      h1: DEFAULT_CHAT_TYPOGRAPHY.h1,
      codeBlock: DEFAULT_CHAT_TYPOGRAPHY.codeBlock,
    });
  });
});
