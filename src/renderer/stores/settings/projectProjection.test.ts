import type { SourceAuthorityProjection } from '@shared/types';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as SettingsModule from './index';

const writeKey = vi.fn(async () => undefined);
const readSettings = vi.fn(async (): Promise<Record<string, unknown> | null> => null);
const sourceAuthorityRead = vi.fn(async () => ({ projects: [], conversations: [] }));
/** 模块加载时注册的 projection 回调；测试用它模拟 Main 的 source-authority 广播 */
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

function projection(paths: string[]): SourceAuthorityProjection {
  return {
    projects: paths.map((path, index) => ({
      projectId: `p${index}`,
      canonicalPath: path,
      state: 'active',
      version: 1,
    })),
    conversations: [],
  } as unknown as SourceAuthorityProjection;
}

describe('project authority projection write guard', () => {
  beforeAll(async () => {
    settingsModule = await import('./index');
  });

  beforeEach(() => {
    settingsModule.useSettingsStore.setState({ projects: [] });
    writeKey.mockClear();
  });

  it('applies a changed projection to the store', () => {
    expect(projectionListener).toBeTypeOf('function');
    projectionListener?.(projection(['/tmp/alpha']));
    expect(settingsModule.useSettingsStore.getState().projects).toEqual([
      { id: 'p0', name: 'alpha', path: '/tmp/alpha' },
    ]);
  });

  it('does not write state again when the projection is unchanged', async () => {
    projectionListener?.(projection(['/tmp/alpha']));
    await Promise.resolve();
    writeKey.mockClear();

    // 同一份投影重复到达（多窗口互相广播时必然发生）。若这里仍然 setState，
    // persist 就会再次落盘 → Main 广播 SETTINGS_CHANGED → 另一窗口 rehydrate 后
    // 又重投影，两个窗口会把 CPU 打满成死循环。
    projectionListener?.(projection(['/tmp/alpha']));
    await Promise.resolve();

    expect(writeKey).not.toHaveBeenCalled();
  });

  it('still writes when the projection actually changes', async () => {
    projectionListener?.(projection(['/tmp/alpha']));
    await Promise.resolve();
    writeKey.mockClear();

    projectionListener?.(projection(['/tmp/alpha', '/tmp/beta']));
    await Promise.resolve();

    expect(settingsModule.useSettingsStore.getState().projects).toHaveLength(2);
    expect(writeKey).toHaveBeenCalled();
  });
});
