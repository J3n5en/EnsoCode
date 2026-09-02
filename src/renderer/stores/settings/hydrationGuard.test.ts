import type { SourceAuthorityProjection } from '@shared/types';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import type * as SettingsModule from './index';

const writeKey = vi.fn(async () => undefined);
let resolveRead: (value: Record<string, unknown> | null) => void = () => {};
const readSettings = vi.fn(
  () =>
    new Promise<Record<string, unknown> | null>((resolve) => {
      resolveRead = resolve;
    })
);
const sourceAuthorityRead = vi.fn(async () => ({ projects: [], conversations: [] }));
let projectionListener: ((projection: SourceAuthorityProjection) => void) | null = null;

vi.stubGlobal('navigator', { language: 'en-US' });
vi.stubGlobal('document', {
  documentElement: {
    lang: 'en',
    classList: { toggle: vi.fn() },
    style: { setProperty: vi.fn(), removeProperty: vi.fn() },
  },
});
vi.stubGlobal('window', {
  matchMedia: () => ({ matches: false, addEventListener: vi.fn() }),
  electronAPI: {
    settings: { read: readSettings, writeKey, onChanged: vi.fn() },
    sourceAuthority: {
      read: sourceAuthorityRead,
      onChanged: vi.fn((listener: (projection: SourceAuthorityProjection) => void) => {
        projectionListener = listener;
        return vi.fn();
      }),
    },
    instructions: { delete: vi.fn(async () => ({ ok: true })) },
  },
});

let settingsModule: typeof SettingsModule;

const projection = {
  projects: [{ projectId: 'p0', canonicalPath: '/tmp/alpha', state: 'active', version: 1 }],
  conversations: [],
} as unknown as SourceAuthorityProjection;

const persisted = {
  'enso-settings': {
    version: 999,
    state: { providers: [{ id: 'prov', name: 'P', baseUrl: 'https://x', apiKey: 'k' }] },
  },
};

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('settings persist hydration guard', () => {
  beforeAll(async () => {
    settingsModule = await import('./index');
  });

  it('never writes default state to disk before the first hydration completes', async () => {
    // 设置窗口刚起：settings.read 还没回，Main 的 source-authority 广播先到
    projectionListener?.(projection);
    await flush();
    expect(settingsModule.useSettingsStore.getState().projects).toHaveLength(1);
    expect(writeKey).not.toHaveBeenCalled();

    resolveRead(persisted);
    await flush();
    expect(settingsModule.useSettingsStore.getState().providers).toHaveLength(1);
    writeKey.mockClear();

    // 水合完成后的写入必须放行，且携带磁盘上的真实配置
    settingsModule.useSettingsStore.getState().setOnboarded(true);
    await flush();
    expect(writeKey).toHaveBeenCalledTimes(1);
    const [, value] = writeKey.mock.calls[0] as unknown as [
      string,
      { state: SettingsModule.SettingsState },
    ];
    expect(value.state.providers).toHaveLength(1);
    expect(value.state.onboarded).toBe(true);
  });
});
