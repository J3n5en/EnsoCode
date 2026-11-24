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

describe('供应商独立代理', () => {
  it('updateProvider 写入代理；跟随全局时删除 proxy 字段而不是留 undefined', () => {
    const store = settings.useSettingsStore;
    store.setState({
      providers: [
        {
          id: 'p',
          name: 'P',
          api: 'openai-completions',
          apiKey: 'k',
          baseUrl: 'https://x.example/v1',
          enabled: true,
          models: [],
        },
      ],
    });
    store.getState().updateProvider('p', { proxy: { mode: 'none' } });
    expect(store.getState().providers[0]?.proxy).toEqual({ mode: 'none' });
    store.getState().updateProvider('p', { name: 'Renamed' });
    expect(store.getState().providers[0]?.proxy).toEqual({ mode: 'none' });
    store.getState().updateProvider('p', { proxy: undefined });
    expect(store.getState().providers[0]).not.toHaveProperty('proxy');
  });
});
