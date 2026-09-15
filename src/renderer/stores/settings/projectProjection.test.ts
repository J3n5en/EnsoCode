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

  it('keeps groupId when source-authority projection refreshes the same project', () => {
    settingsModule.useSettingsStore.setState({
      projects: [{ id: 'p0', name: 'alpha', path: '/tmp/alpha', groupId: 'work' }],
    });
    writeKey.mockClear();
    projectionListener?.(projection(['/tmp/alpha']));
    expect(settingsModule.useSettingsStore.getState().projects).toEqual([
      { id: 'p0', name: 'alpha', path: '/tmp/alpha', groupId: 'work' },
    ]);
  });

  // 别名与项目级默认模型只存在于渲染侧设置，投影里没有对应字段；
  // 重建时不带上就会被广播抹掉（新建对话必定触发一次广播）。
  it('keeps alias and project-level default model across a projection refresh', () => {
    const local = {
      id: 'p0',
      name: 'alpha',
      path: '/tmp/alpha',
      alias: '线上',
      defaultModel: { providerId: 'anthropic', modelId: 'claude' },
      // 取 false：只有 `!== undefined` 判断才留得住，真值判断会把它丢掉
      defaultReasoningEnabled: false,
      defaultThinkingLevel: 'high' as const,
    };
    settingsModule.useSettingsStore.setState({ projects: [local] });
    writeKey.mockClear();

    projectionListener?.(projection(['/tmp/alpha', '/tmp/beta']));

    const [alpha] = settingsModule.useSettingsStore.getState().projects;
    expect(alpha).toEqual(local);
  });

  // 投影按 registry 的插入顺序下发，本地数组顺序可能不同（项目删除后重建会错位）。
  // 顺序差异不是内容变化，按索引比对会让每次广播都重写整个数组。
  it('treats a reordered projection with the same projects as unchanged', async () => {
    settingsModule.useSettingsStore.setState({
      projects: [
        { id: 'p1', name: 'beta', path: '/tmp/beta' },
        { id: 'p0', name: 'alpha', path: '/tmp/alpha', alias: '线上' },
      ],
    });
    writeKey.mockClear();

    projectionListener?.(projection(['/tmp/alpha', '/tmp/beta']));
    await Promise.resolve();

    expect(writeKey).not.toHaveBeenCalled();
    expect(settingsModule.useSettingsStore.getState().projects[1]?.alias).toBe('线上');
  });
});
