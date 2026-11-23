import { describe, expect, it, vi } from 'vitest';

vi.stubGlobal('navigator', { language: 'en-US' });
vi.stubGlobal('document', {
  documentElement: {
    dataset: {},
    lang: 'en',
    classList: { toggle: vi.fn() },
    style: { setProperty: vi.fn(), removeProperty: vi.fn() },
  },
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
  },
});

const settings = await import('./index');

describe('webSearchChain settings', () => {
  it('缺省为空链；setWebSearchChain 收窄脏数据并去重', () => {
    expect(settings.useSettingsStore.getState().webSearchChain).toEqual([]);
    settings.useSettingsStore
      .getState()
      .setWebSearchChain([
        { providerId: 'ga', modelId: 'gemini-3.8-flash' },
        { providerId: 'ga', modelId: 'gemini-3.8-flash' },
        { providerId: '', modelId: 'bad' } as never,
      ]);
    expect(settings.useSettingsStore.getState().webSearchChain).toEqual([
      { providerId: 'ga', modelId: 'gemini-3.8-flash' },
    ]);
    settings.useSettingsStore.getState().setWebSearchChain([]);
    expect(settings.useSettingsStore.getState().webSearchChain).toEqual([]);
  });
});
