import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useSessionsStore } from '@/stores/sessions';
import { useSettingsStore } from '@/stores/settings';
import { bindSidePanelFullscreen, type PinnableSidePanelTab, useSidePanelStore } from './index';
import { SIDE_PANEL_VERSION } from './migrate';

const sessionListeners = vi.hoisted(() => ({
  current: new Set<
    (state: { activeId: string | null }, prev: { activeId: string | null }) => void
  >(),
}));

vi.hoisted(() => {
  const memory = new Map<string, string>();
  const storage = {
    getItem: (key: string) => memory.get(key) ?? null,
    setItem: (key: string, value: string) => {
      memory.set(key, value);
    },
    removeItem: (key: string) => {
      memory.delete(key);
    },
  };
  Object.defineProperty(globalThis, 'localStorage', { value: storage, configurable: true });
  Object.defineProperty(globalThis, 'window', {
    value: { localStorage: storage },
    configurable: true,
  });
});

vi.mock('@/stores/sessions', () => ({
  useSessionsStore: {
    getState: vi.fn(),
    subscribe: (
      listener: (state: { activeId: string | null }, prev: { activeId: string | null }) => void
    ) => {
      sessionListeners.current.add(listener);
      return () => {
        sessionListeners.current.delete(listener);
      };
    },
  },
}));

vi.mock('@/stores/settings', () => ({
  useSettingsStore: { getState: vi.fn() },
}));

function sessions(activeId: string) {
  vi.mocked(useSessionsStore.getState).mockReturnValue({
    activeId,
    conversations: {
      secretary: { projectId: 'sec' },
      normal: { projectId: 'code' },
    },
  } as unknown as ReturnType<typeof useSessionsStore.getState>);
}

describe('固定默认标签', () => {
  it('固定、取消固定，脏值也能重新记成列表', () => {
    useSidePanelStore.setState({ pinnedTabs: [] });
    useSidePanelStore.getState().togglePinnedTab('files');
    useSidePanelStore.getState().togglePinnedTab('browser');
    expect(useSidePanelStore.getState().pinnedTabs).toEqual(['files', 'browser']);
    useSidePanelStore.getState().togglePinnedTab('files');
    expect(useSidePanelStore.getState().pinnedTabs).toEqual(['browser']);

    useSidePanelStore.setState({
      pinnedTabs: 'files' as unknown as PinnableSidePanelTab[],
    });
    expect(() => useSidePanelStore.getState().togglePinnedTab('changes')).not.toThrow();
    expect(useSidePanelStore.getState().pinnedTabs).toEqual(['changes']);
  });
});

describe('侧栏开关按会话独立', () => {
  beforeEach(() => {
    vi.mocked(useSettingsStore.getState).mockReturnValue({
      projects: [
        { id: 'sec', kind: 'secretary' },
        { id: 'code', kind: 'project' },
      ],
    } as unknown as ReturnType<typeof useSettingsStore.getState>);
    useSidePanelStore.setState((state) => ({
      ...state,
      fullscreen: false,
      fullscreenByConversation: {},
      uiByConversation: {},
      layouts: {},
    }));
  });

  it('秘书侧栏全屏打开时，切到普通会话能独立打开侧栏', () => {
    sessions('secretary');
    useSidePanelStore.getState().toggleOpen();
    useSidePanelStore.getState().toggleFullscreen();

    sessions('normal');
    useSidePanelStore.getState().reconcileForActiveConversation();
    useSidePanelStore.getState().toggleOpen();

    const state = useSidePanelStore.getState();
    expect(state.uiByConversation.normal?.open).toBe(true);
    expect(state.fullscreen).toBe(false);
    expect(state.uiByConversation.secretary?.open).toBe(true);
    expect(state.fullscreenByConversation.secretary).toBe(true);
  });

  it('切回秘书时，秘书原来的全屏打开状态还在', () => {
    sessions('secretary');
    useSidePanelStore.getState().toggleOpen();
    useSidePanelStore.getState().toggleFullscreen();
    sessions('normal');
    useSidePanelStore.getState().reconcileForActiveConversation();
    useSidePanelStore.getState().toggleOpen();

    sessions('secretary');
    useSidePanelStore.getState().reconcileForActiveConversation();

    const state = useSidePanelStore.getState();
    expect(state.uiByConversation.secretary?.open).toBe(true);
    expect(state.fullscreen).toBe(true);
    expect(state.uiByConversation.normal?.open).toBe(true);
    expect(state.fullscreenByConversation.normal).toBe(false);
  });

  it('当前会话的全屏记忆已在内存里时，绑定后不用切会话也会进入全屏', () => {
    sessions('secretary');
    useSidePanelStore.setState((state) => ({
      ...state,
      fullscreen: false,
      fullscreenByConversation: { secretary: true },
      uiByConversation: { secretary: { open: true, width: state.lastWidth } },
    }));

    const stop = bindSidePanelFullscreen();
    try {
      expect(useSidePanelStore.getState().fullscreen).toBe(true);
    } finally {
      stop();
    }
  });

  it('重新读入已保存的全屏记忆后，当前会话直接进入全屏', async () => {
    sessions('secretary');
    localStorage.setItem(
      'enso-side-panel',
      JSON.stringify({
        state: {
          lastWidth: 480,
          uiByConversation: { secretary: { open: true, width: 480 } },
          fullscreenByConversation: { secretary: true },
          layouts: {},
          changesModeByConversation: {},
        },
        version: SIDE_PANEL_VERSION,
      })
    );

    const stop = bindSidePanelFullscreen();
    try {
      await useSidePanelStore.persist.rehydrate();
      const state = useSidePanelStore.getState();
      expect(state.fullscreenByConversation.secretary).toBe(true);
      expect(state.uiByConversation.secretary?.open).toBe(true);
      expect(state.fullscreen).toBe(true);
    } finally {
      stop();
      localStorage.removeItem('enso-side-panel');
    }
  });

  it('绑定期间切会话会换成目标会话自己的全屏', () => {
    sessions('secretary');
    useSidePanelStore.getState().toggleOpen();
    useSidePanelStore.getState().toggleFullscreen();
    const stop = bindSidePanelFullscreen();
    try {
      sessions('normal');
      for (const listener of sessionListeners.current) {
        listener({ activeId: 'normal' }, { activeId: 'secretary' });
      }
      const state = useSidePanelStore.getState();
      expect(state.fullscreen).toBe(false);
      expect(state.fullscreenByConversation.secretary).toBe(true);
    } finally {
      stop();
    }
  });

  it('秘书侧栏关着时切走，切回来仍然关着', () => {
    sessions('secretary');
    sessions('normal');
    useSidePanelStore.getState().reconcileForActiveConversation();
    useSidePanelStore.getState().toggleOpen();

    sessions('secretary');
    useSidePanelStore.getState().reconcileForActiveConversation();

    const state = useSidePanelStore.getState();
    expect(state.uiByConversation.secretary?.open).toBeFalsy();
    expect(state.fullscreen).toBe(false);
    expect(state.uiByConversation.normal?.open).toBe(true);
  });
});

describe('全局标签与三态开关', () => {
  beforeEach(() => {
    vi.mocked(useSettingsStore.getState).mockReturnValue({
      projects: [{ id: 'code', kind: 'project' }],
    } as unknown as ReturnType<typeof useSettingsStore.getState>);
    useSidePanelStore.setState((state) => ({
      ...state,
      fullscreen: false,
      fullscreenByConversation: {},
      uiByConversation: {},
      layouts: {},
      globalTabs: ['plugin:radio:player'],
      liveGlobalTabs: ['plugin:radio:player'],
    }));
  });

  it('全局标签自动显示的会话，点开关是收起并记成明确关过', () => {
    sessions('normal');
    useSidePanelStore.getState().toggleOpen();
    expect(useSidePanelStore.getState().uiByConversation.normal?.open).toBe(false);
    useSidePanelStore.getState().toggleOpen();
    expect(useSidePanelStore.getState().uiByConversation.normal?.open).toBe(true);
  });

  it('只调宽度不会把没开关过的会话写成关着', () => {
    sessions('normal');
    useSidePanelStore.getState().nudgeWidth(-20, 2000, 8);
    expect(useSidePanelStore.getState().uiByConversation.normal?.open).toBeUndefined();
  });

  it('删除会话不影响 globalTabs 与作用域覆盖', () => {
    useSidePanelStore.setState({
      globalScopeOverrides: { 'plugin:radio:player': 'global' },
      uiByConversation: { normal: { open: true, width: 400 } },
    });
    useSidePanelStore.getState().forgetConversation('normal');
    const state = useSidePanelStore.getState();
    expect(state.globalTabs).toEqual(['plugin:radio:player']);
    expect(state.globalScopeOverrides).toEqual({ 'plugin:radio:player': 'global' });
    expect(state.uiByConversation.normal).toBeUndefined();
  });

  it('全局关闭从没挂载会话的布局里摘掉该面板，摘空且开着的侧栏收起，保留的会话不动', () => {
    const leaf = (views: string[]) => ({
      grid: {
        root: {
          type: 'branch',
          data: [{ type: 'leaf', data: { views, id: 'g' }, size: 1 }],
          size: 1,
        },
        width: 1,
        height: 1,
        orientation: 'HORIZONTAL',
      },
      panels: Object.fromEntries(views.map((id) => [id, { id, contentComponent: 'plugin' }])),
    });
    useSidePanelStore.setState({
      layouts: {
        a: leaf(['plugin:radio:player']),
        b: leaf(['plugin:radio:player', 'plugin:notes:board']),
        keep: leaf(['plugin:radio:player']),
      } as never,
      uiByConversation: { a: { open: true, width: 400 }, keep: { open: true, width: 400 } },
    });
    useSidePanelStore.getState().dropPanelFromLayouts('plugin:radio:player', new Set(['keep']));
    const state = useSidePanelStore.getState();
    expect(state.layouts.a).toBeUndefined();
    expect(state.uiByConversation.a?.open).toBe(false);
    expect(Object.keys(state.layouts.b?.panels ?? {})).toEqual(['plugin:notes:board']);
    expect(Object.keys(state.layouts.keep?.panels ?? {})).toEqual(['plugin:radio:player']);
    expect(state.uiByConversation.keep?.open).toBe(true);
  });

  it('读回 v4 数据：老字段都在，全局字段为空', async () => {
    sessions('normal');
    localStorage.setItem(
      'enso-side-panel',
      JSON.stringify({
        state: {
          lastWidth: 480,
          uiByConversation: { normal: { open: true, width: 480 } },
          fullscreenByConversation: {},
          layouts: { normal: { panels: {} } },
          pinnedTabs: ['files'],
          changesModeByConversation: { normal: 'git' },
        },
        version: 4,
      })
    );
    try {
      await useSidePanelStore.persist.rehydrate();
      const state = useSidePanelStore.getState();
      expect(state.lastWidth).toBe(480);
      expect(state.pinnedTabs).toEqual(['files']);
      expect(state.layouts.normal).toEqual({ panels: {} });
      expect(state.uiByConversation.normal?.open).toBe(true);
      expect(state.changesModeByConversation.normal).toBe('git');
      expect(state.globalTabs).toEqual([]);
      expect(state.globalScopeOverrides).toEqual({});
    } finally {
      localStorage.removeItem('enso-side-panel');
    }
  });
});

describe('文件树宽度', () => {
  beforeEach(() => {
    useSidePanelStore.setState({ filesTreeWidth: 224 });
  });

  it('拖动按增量调整并夹在 160–480', () => {
    useSidePanelStore.getState().nudgeFilesTreeWidth(40);
    expect(useSidePanelStore.getState().filesTreeWidth).toBe(264);
    useSidePanelStore.getState().nudgeFilesTreeWidth(1000);
    expect(useSidePanelStore.getState().filesTreeWidth).toBe(480);
    useSidePanelStore.getState().nudgeFilesTreeWidth(-1000);
    expect(useSidePanelStore.getState().filesTreeWidth).toBe(160);
  });

  it('按面板宽度夹住，编辑区不被挤没', () => {
    useSidePanelStore.getState().nudgeFilesTreeWidth(1000, 600);
    expect(useSidePanelStore.getState().filesTreeWidth).toBe(359);
  });

  it('宽度随侧栏偏好持久化，读回仍是上次的值', async () => {
    useSidePanelStore.getState().nudgeFilesTreeWidth(76);
    const saved = JSON.parse(localStorage.getItem('enso-side-panel') ?? '{}');
    expect(saved.state.filesTreeWidth).toBe(300);

    useSidePanelStore.setState({ filesTreeWidth: 224 });
    localStorage.setItem('enso-side-panel', JSON.stringify(saved));
    try {
      await useSidePanelStore.persist.rehydrate();
      expect(useSidePanelStore.getState().filesTreeWidth).toBe(300);
    } finally {
      localStorage.removeItem('enso-side-panel');
    }
  });
});
