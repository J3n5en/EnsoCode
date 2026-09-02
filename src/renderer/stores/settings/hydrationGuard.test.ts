import type { SourceAuthorityProjection } from '@shared/types';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import type * as SettingsModule from './index';
import { SETTINGS_VERSION } from './migrate';

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

const projection = (paths: string[]) =>
  ({
    projects: paths.map((path, i) => ({
      projectId: `p${i}`,
      canonicalPath: path,
      state: 'active',
      version: 1,
    })),
    conversations: [],
  }) as unknown as SourceAuthorityProjection;

const providers = [{ id: 'prov', name: 'P', baseUrl: 'https://x', apiKey: 'k' }];
const persisted = { 'enso-settings': { version: SETTINGS_VERSION, state: { providers } } };

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
const writtenProviders = () =>
  writeKey.mock.calls.map(
    (call) =>
      (call as unknown as [string, { state: SettingsModule.SettingsState }])[1].state.providers
  );

describe('settings persist hydration guard', () => {
  beforeAll(async () => {
    settingsModule = await import('./index');
  });

  it('drops every write that lands before persist has merged the first read', async () => {
    // 设置窗刚起：settings.read 还没回，Main 的 source-authority 广播先到
    projectionListener?.(projection(['/tmp/alpha']));
    await flush();
    expect(settingsModule.useSettingsStore.getState().projects).toHaveLength(1);
    expect(writeKey).not.toHaveBeenCalled();

    // 回包已到但 getItem 还没结算、persist 还没 merge：同一 tick 内再来一条广播
    resolveRead(persisted);
    projectionListener?.(projection(['/tmp/alpha', '/tmp/beta']));
    await flush();
    expect(settingsModule.useSettingsStore.getState().providers).toEqual(providers);
    // version 与当前一致，无 migrate 回写；水合后 onRehydrateStorage 的补写（老用户标 onboarded、
    // 重投影）允许发生，但每一次落盘都必须带着磁盘上的真实 providers —— 空默认值一次都不能出现
    expect(writeKey).toHaveBeenCalled();
    expect(writtenProviders().every((p) => p.length === 1)).toBe(true);

    const before = writeKey.mock.calls.length;
    settingsModule.useSettingsStore.getState().setTheme('dark');
    await flush();
    expect(writeKey).toHaveBeenCalledTimes(before + 1);
    expect(writtenProviders().at(-1)).toEqual(providers);
  });
});
