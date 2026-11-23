import type { DockviewApi } from 'dockview-react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const harness = vi.hoisted(() => ({
  state: {
    globalTabs: [] as string[],
    globalScopeOverrides: {} as Record<string, 'global' | 'session'>,
    uiByConversation: {} as Record<string, { open?: boolean; width: number }>,
    liveGlobalTabs: [] as string[],
    layouts: {} as Record<string, unknown>,
    dropped: [] as { panelId: string; keep: string[] }[],
  },
}));

vi.mock('@/stores/sessions', () => ({
  useSessionsStore: {
    getState: () => ({
      activeId: 'a',
      conversations: { a: { projectId: 'p1' }, b: { projectId: 'p2' }, c: { projectId: 'p1' } },
    }),
  },
}));
vi.mock('@/stores/settings', () => ({
  useSettingsStore: { getState: () => ({ disabledBuiltinTools: [], projects: [] }) },
}));
vi.mock('@/stores/sidePanel', () => ({
  useSidePanelStore: {
    getState: () => ({
      ...harness.state,
      setGlobalTabs: (tabs: string[]) => {
        harness.state.globalTabs = tabs;
      },
      setGlobalScopeOverride: (id: string, scope: 'global' | 'session' | undefined) => {
        const { [id]: _old, ...rest } = harness.state.globalScopeOverrides;
        harness.state.globalScopeOverrides = scope ? { ...rest, [id]: scope } : rest;
      },
      dropPanelFromLayouts: (panelId: string, keep: ReadonlySet<string>) => {
        harness.state.dropped.push({ panelId, keep: [...keep].sort() });
      },
      ensureOpen: vi.fn(),
      forgetConversation: vi.fn(),
    }),
    setState: vi.fn(),
    subscribe: () => () => {},
  },
}));

import { setPluginViews } from '../plugins/viewBridge';
import {
  bindSidePanelDock,
  closeGlobalTab,
  disposeConversationResources,
  openGlobalTab,
  pruneUndeclaredPluginTabs,
  setPluginPanelScope,
  syncDockGlobalTabs,
  unbindSidePanelDock,
  watchGlobalTabs,
} from './sidePanelDock';

const RADIO = 'plugin:radio:player';
const NOTES = 'plugin:notes:board';

interface FakePanel {
  id: string;
  inactive?: boolean;
  group: { panels: FakePanel[] };
  api: { close: () => void; setActive: () => void };
  focus: () => void;
}

function fakeDock() {
  const panels: FakePanel[] = [];
  const listeners = new Set<(panel: { id: string }) => void>();
  const addListeners = new Set<(panel: { id: string }) => void>();
  let active: string | undefined;
  const remove = (id: string) => {
    const index = panels.findIndex((panel) => panel.id === id);
    if (index < 0) return;
    const [panel] = panels.splice(index, 1);
    for (const listener of [...listeners]) listener(panel);
  };
  const make = (id: string, inactive?: boolean): FakePanel => ({
    id,
    inactive,
    group: { panels },
    api: {
      close: () => remove(id),
      setActive: () => {
        active = id;
      },
    },
    focus: () => {
      active = id;
    },
  });
  const api = {
    panels,
    groups: [{ id: 'g1' }],
    get activePanel() {
      return active ? { id: active } : undefined;
    },
    getPanel: (id: string) => panels.find((panel) => panel.id === id),
    addPanel: (opts: { id: string; inactive?: boolean }) => {
      const panel = make(opts.id, opts.inactive);
      panels.push(panel);
      if (!opts.inactive) active = opts.id;
      for (const listener of [...addListeners]) listener(panel);
    },
    onDidRemovePanel: (listener: (panel: { id: string }) => void) => {
      listeners.add(listener);
      return { dispose: () => listeners.delete(listener) };
    },
    onDidAddPanel: (listener: (panel: { id: string }) => void) => {
      addListeners.add(listener);
      return { dispose: () => addListeners.delete(listener) };
    },
  };
  return {
    api: api as unknown as DockviewApi,
    ids: () => panels.map((panel) => panel.id),
    add: (id: string) => panels.push(make(id)),
    userAdd: (id: string) => api.addPanel({ id }),
    userClose: (id: string) => remove(id),
    panel: (id: string) => panels.find((panel) => panel.id === id),
    active: () => active,
  };
}

function mount(id: string) {
  const dock = fakeDock();
  bindSidePanelDock(id, dock.api);
  watchGlobalTabs(id, dock.api);
  return dock;
}

describe('全局标签跨 dock 同步', () => {
  beforeEach(() => {
    vi.stubGlobal('window', {});
    for (const id of ['a', 'b', 'c']) disposeConversationResources(id);
    harness.state.globalTabs = [];
    harness.state.globalScopeOverrides = {};
    harness.state.uiByConversation = {};
    harness.state.dropped = [];
    setPluginViews([
      {
        pluginId: 'radio',
        pluginName: 'Radio',
        id: 'player',
        title: 'Radio',
        entry: 'p.html',
        scope: 'global',
      },
      { pluginId: 'notes', pluginName: 'Notes', id: 'board', title: 'Notes', entry: 'n.html' },
    ]);
  });

  it('在一个会话打开：进 globalTabs，所有已挂载 dock 补上，只有发起的会话选中', () => {
    const a = mount('a');
    const b = mount('b');
    b.add('secretary');
    openGlobalTab(RADIO, 'a');
    expect(harness.state.globalTabs).toEqual([RADIO]);
    expect(a.ids()).toEqual([RADIO]);
    expect(a.active()).toBe(RADIO);
    expect(b.ids()).toEqual(['secretary', RADIO]);
    expect(b.panel(RADIO)?.inactive).toBe(true);
  });

  it('补进空 dock 时正常激活，免得后加的面板另开分屏', () => {
    mount('a');
    const b = mount('b');
    openGlobalTab(RADIO, 'a');
    expect(b.panel(RADIO)?.inactive).toBe(false);
  });

  it('从新建菜单等任意入口在 dock 里加了全局页面，也算打开全局标签', () => {
    const a = mount('a');
    const b = mount('b');
    b.add('files');
    a.userAdd(RADIO);
    expect(harness.state.globalTabs).toEqual([RADIO]);
    expect(b.ids()).toEqual(['files', RADIO]);
    expect(b.panel(RADIO)?.inactive).toBe(true);
    a.userAdd(NOTES);
    expect(harness.state.globalTabs).toEqual([RADIO]);
    expect(b.ids()).toEqual(['files', RADIO]);
  });

  it('用户在任一会话关掉：所有 dock 一起关，只触发一次全局关闭，未挂载布局也摘掉', () => {
    const a = mount('a');
    const b = mount('b');
    openGlobalTab(RADIO, 'a');
    b.userClose(RADIO);
    expect(harness.state.globalTabs).toEqual([]);
    expect(a.ids()).toEqual([]);
    expect(harness.state.dropped).toEqual([{ panelId: RADIO, keep: ['a', 'b'] }]);
  });

  it('同步中的移除不回头触发全局关闭（来回触发防护）', () => {
    mount('a');
    mount('b');
    openGlobalTab(RADIO, 'a');
    closeGlobalTab(RADIO);
    expect(harness.state.dropped).toHaveLength(1);
  });

  it('会话面板（不在 globalTabs）关掉不影响别的会话', () => {
    const a = mount('a');
    const b = mount('b');
    a.add(NOTES);
    b.add(NOTES);
    a.userClose(NOTES);
    expect(b.ids()).toEqual([NOTES]);
    expect(harness.state.dropped).toEqual([]);
  });

  it('挂载时补齐缺的、删掉多余的；侧栏开着的旧布局收进 globalTabs', () => {
    harness.state.globalTabs = [RADIO];
    const b = mount('b');
    syncDockGlobalTabs('b', b.api, true);
    expect(b.ids()).toEqual([RADIO]);

    harness.state.globalTabs = [];
    const c = mount('c');
    c.add(RADIO);
    syncDockGlobalTabs('c', c.api, true);
    expect(c.ids()).toEqual([]);

    harness.state.uiByConversation = { a: { open: true, width: 400 } };
    const a = mount('a');
    a.add(RADIO);
    syncDockGlobalTabs('a', a.api, true);
    expect(a.ids()).toEqual([RADIO]);
    expect(harness.state.globalTabs).toEqual([RADIO]);
  });

  it('删除会话、dock 卸载都不动 globalTabs', () => {
    const a = mount('a');
    mount('b');
    openGlobalTab(RADIO, 'a');
    unbindSidePanelDock('a', a.api);
    a.userClose(RADIO);
    disposeConversationResources('b');
    expect(harness.state.globalTabs).toEqual([RADIO]);
  });

  it('右键改作用域：会话→全局补进其他 dock；全局→会话只留在当前会话', () => {
    const a = mount('a');
    const b = mount('b');
    a.add(NOTES);
    setPluginPanelScope(NOTES, 'a', 'global');
    expect(harness.state.globalScopeOverrides).toEqual({ [NOTES]: 'global' });
    expect(harness.state.globalTabs).toEqual([NOTES]);
    expect(b.ids()).toEqual([NOTES]);

    setPluginPanelScope(NOTES, 'a', 'session');
    expect(harness.state.globalScopeOverrides).toEqual({});
    expect(harness.state.globalTabs).toEqual([]);
    expect(a.ids()).toEqual([NOTES]);
    expect(b.ids()).toEqual([]);
    expect(harness.state.dropped.at(-1)).toEqual({ panelId: NOTES, keep: ['a', 'b'] });
  });
});

const WATCH = 'plugin:enso.github:watch';
const PRS = 'plugin:enso.github:prs';

function summary(id: string, state: 'enabled' | 'disabled' | 'crashed', views: string[]) {
  return {
    id,
    state,
    views: views.map((view) => ({ id: view, title: view, entry: `${view}.html` })),
  };
}

function storedLayout(...ids: string[]) {
  return {
    grid: { root: { type: 'leaf', data: { views: ids, activeView: ids[0], id: 'g1' } } },
    panels: Object.fromEntries(ids.map((id) => [id, { id, contentComponent: 'plugin' }])),
  };
}

describe('插件不再声明的视图标签自动清理', () => {
  beforeEach(() => {
    vi.stubGlobal('window', {});
    for (const id of ['a', 'b', 'c']) disposeConversationResources(id);
    harness.state.globalTabs = [];
    harness.state.globalScopeOverrides = {};
    harness.state.uiByConversation = {};
    harness.state.layouts = {};
    harness.state.dropped = [];
    setPluginViews([
      {
        pluginId: 'enso.github',
        pluginName: 'GitHub',
        id: 'watch',
        title: 'GitHub 监听',
        entry: 'watch.html',
        scope: 'global',
      },
    ]);
  });

  it('升级后清单里没了的视图：全局标签、各已挂载 dock 与未挂载会话布局都清掉', () => {
    const a = mount('a');
    const b = mount('b');
    a.add('files');
    openGlobalTab(WATCH, 'a');
    b.add(PRS);
    harness.state.layouts = { c: storedLayout('plugin:enso.github:old-session', PRS) };
    setPluginViews([]);

    pruneUndeclaredPluginTabs([summary('enso.github', 'enabled', ['prs'])]);

    expect(harness.state.globalTabs).toEqual([]);
    expect(a.ids()).toEqual(['files']);
    expect(b.ids()).toEqual([PRS]);
    expect(harness.state.dropped).toEqual([
      { panelId: WATCH, keep: ['a', 'b'] },
      { panelId: 'plugin:enso.github:old-session', keep: ['a', 'b'] },
    ]);
  });

  it('插件禁用或卸载：标签全部保留', () => {
    const a = mount('a');
    openGlobalTab(WATCH, 'a');
    harness.state.layouts = { c: storedLayout(WATCH) };
    setPluginViews([]);

    pruneUndeclaredPluginTabs([summary('enso.github', 'disabled', [])]);
    pruneUndeclaredPluginTabs([]);

    expect(harness.state.globalTabs).toEqual([WATCH]);
    expect(a.ids()).toEqual([WATCH]);
    expect(harness.state.dropped).toEqual([]);
  });

  it('插件崩溃或清单读不出（不在列表里）：不删任何标签', () => {
    const a = mount('a');
    openGlobalTab(WATCH, 'a');

    pruneUndeclaredPluginTabs([summary('enso.github', 'crashed', [])]);
    pruneUndeclaredPluginTabs([summary('other', 'enabled', [])]);

    expect(harness.state.globalTabs).toEqual([WATCH]);
    expect(a.ids()).toEqual([WATCH]);
    expect(harness.state.dropped).toEqual([]);
  });

  it('仍在声明中的视图与非插件标签不受影响', () => {
    const a = mount('a');
    a.add('files');
    a.add('terminal-1');
    a.add('browser:1');
    openGlobalTab(WATCH, 'a');
    a.add('plugin:other:view');
    harness.state.layouts = { c: storedLayout(WATCH, 'files') };

    pruneUndeclaredPluginTabs([summary('enso.github', 'enabled', ['watch'])]);

    expect(harness.state.globalTabs).toEqual([WATCH]);
    expect(a.ids()).toEqual(['files', 'terminal-1', 'browser:1', WATCH, 'plugin:other:view']);
    expect(harness.state.dropped).toEqual([]);
  });

  it('删的是激活标签：切到相邻标签，优先左边', () => {
    const a = mount('a');
    a.add('files');
    a.add('terminal-1');
    openGlobalTab(WATCH, 'a');
    a.add('browser:1');
    const b = mount('b');
    b.add(WATCH);
    b.add('files');
    b.panel(WATCH)?.focus();
    expect(a.active()).toBe(WATCH);

    pruneUndeclaredPluginTabs([summary('enso.github', 'enabled', [])]);

    expect(a.ids()).toEqual(['files', 'terminal-1', 'browser:1']);
    expect(a.active()).toBe('terminal-1');
    expect(b.ids()).toEqual(['files']);
    expect(b.active()).toBe('files');
  });
});
