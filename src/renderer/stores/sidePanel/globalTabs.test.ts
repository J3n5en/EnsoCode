import { describe, expect, it } from 'vitest';
import {
  createSyncGuard,
  globalPanelIds,
  liveGlobalTabs,
  normalizeGlobalState,
  planGlobalTabSync,
  resolvePanelScope,
  selectSidePanelShown,
  withGlobalTab,
} from './globalTabs';

const views = [
  { pluginId: 'radio', id: 'player', scope: 'global' as const },
  { pluginId: 'tg', id: 'chat', scope: 'global' as const },
  { pluginId: 'notes', id: 'board', scope: 'session' as const },
  { pluginId: 'kanban', id: 'main' },
];

describe('resolvePanelScope', () => {
  it('用户覆盖优先，其次清单声明，缺省按会话', () => {
    expect(resolvePanelScope('plugin:radio:player', {}, views)).toBe('global');
    expect(resolvePanelScope('plugin:notes:board', {}, views)).toBe('session');
    expect(resolvePanelScope('plugin:kanban:main', {}, views)).toBe('session');
    expect(
      resolvePanelScope('plugin:radio:player', { 'plugin:radio:player': 'session' }, views)
    ).toBe('session');
    expect(resolvePanelScope('plugin:kanban:main', { 'plugin:kanban:main': 'global' }, views)).toBe(
      'global'
    );
  });

  it('内置面板和没加载的插件都按会话', () => {
    expect(resolvePanelScope('files', { files: 'global' }, views)).toBe('session');
    expect(resolvePanelScope('plugin:gone:x', {}, views)).toBe('session');
    expect(resolvePanelScope('plugin:gone:x', { 'plugin:gone:x': 'global' }, views)).toBe(
      'session'
    );
  });

  it('globalPanelIds 只列实际作用域为全局、且已启用的页面', () => {
    expect([...globalPanelIds(views, { 'plugin:tg:chat': 'session' })]).toEqual([
      'plugin:radio:player',
    ]);
  });
});

describe('liveGlobalTabs', () => {
  it('插件列表到达前原样返回，到达后去掉已停用或改回会话的', () => {
    const tabs = ['plugin:tg:chat', 'plugin:gone:x', 'plugin:radio:player'];
    expect(liveGlobalTabs(tabs, [], {}, false)).toEqual(tabs);
    expect(liveGlobalTabs(tabs, views, { 'plugin:tg:chat': 'session' }, true)).toEqual([
      'plugin:radio:player',
    ]);
  });
});

describe('selectSidePanelShown 三态开关', () => {
  const state = (open: boolean | undefined, live: string[]) => ({
    uiByConversation: open === undefined ? {} : { c: { open, width: 400 } },
    liveGlobalTabs: live,
  });

  it('明确打开就显示，明确关过就不显示', () => {
    expect(selectSidePanelShown(state(true, []), 'c', false)).toBe(true);
    expect(selectSidePanelShown(state(false, ['plugin:radio:player']), 'c', false)).toBe(false);
  });

  it('没开关过的会话在有全局标签时自动显示', () => {
    expect(selectSidePanelShown(state(undefined, []), 'c', false)).toBe(false);
    expect(selectSidePanelShown(state(undefined, ['plugin:radio:player']), 'c', false)).toBe(true);
  });

  it('只调过宽度、没开关过的会话仍算没开关过', () => {
    expect(
      selectSidePanelShown(
        { uiByConversation: { c: { width: 500 } }, liveGlobalTabs: ['plugin:radio:player'] },
        'c',
        false
      )
    ).toBe(true);
  });

  it('手机端全局标签不触发自动打开，用户自己打开仍显示', () => {
    expect(selectSidePanelShown(state(undefined, ['plugin:radio:player']), 'c', true)).toBe(false);
    expect(selectSidePanelShown(state(true, ['plugin:radio:player']), 'c', true)).toBe(true);
  });

  it('没有当前会话时不显示', () => {
    expect(selectSidePanelShown(state(true, ['plugin:radio:player']), null, false)).toBe(false);
  });
});

describe('planGlobalTabSync', () => {
  const globalIds = new Set(['plugin:radio:player', 'plugin:tg:chat']);

  it('补齐缺的全局标签，按 globalTabs 顺序', () => {
    expect(
      planGlobalTabSync({
        globalTabs: ['plugin:tg:chat', 'plugin:radio:player'],
        globalIds,
        dockPanelIds: ['files', 'plugin:radio:player'],
        adopt: false,
        pruneExtras: false,
      })
    ).toEqual({ adopt: [], add: ['plugin:tg:chat'], remove: [] });
  });

  it('补齐时跳过已停用的页面', () => {
    expect(
      planGlobalTabSync({
        globalTabs: ['plugin:gone:x'],
        globalIds,
        dockPanelIds: [],
        adopt: false,
        pruneExtras: true,
      })
    ).toEqual({ adopt: [], add: [], remove: [] });
  });

  it('挂载时删掉不在 globalTabs 里的全局标签，会话面板不动', () => {
    expect(
      planGlobalTabSync({
        globalTabs: [],
        globalIds,
        dockPanelIds: ['plugin:radio:player', 'plugin:notes:board', 'files'],
        adopt: false,
        pruneExtras: true,
      })
    ).toEqual({ adopt: [], add: [], remove: ['plugin:radio:player'] });
  });

  it('侧栏开着的旧布局里的全局插件面板收进 globalTabs，不删', () => {
    expect(
      planGlobalTabSync({
        globalTabs: ['plugin:tg:chat'],
        globalIds,
        dockPanelIds: ['plugin:radio:player'],
        adopt: true,
        pruneExtras: true,
      })
    ).toEqual({ adopt: ['plugin:radio:player'], add: ['plugin:tg:chat'], remove: [] });
  });

  it('withGlobalTab 追加到末尾且不重复', () => {
    expect(withGlobalTab(['a'], 'b')).toEqual(['a', 'b']);
    const same = ['a', 'b'];
    expect(withGlobalTab(same, 'a')).toBe(same);
  });
});

describe('createSyncGuard 同步标记', () => {
  it('同步期间触发的移除回调能看到标记，结束后（含抛错）复位', () => {
    const guard = createSyncGuard();
    const seen: boolean[] = [];
    guard.run(() => {
      seen.push(guard.active());
      guard.run(() => seen.push(guard.active()));
      seen.push(guard.active());
    });
    seen.push(guard.active());
    expect(seen).toEqual([true, true, true, false]);
    expect(() =>
      guard.run(() => {
        throw new Error('boom');
      })
    ).toThrow('boom');
    expect(guard.active()).toBe(false);
  });
});

describe('normalizeGlobalState', () => {
  it('脏值收成空列表/空表，只留插件面板 id 与合法作用域', () => {
    expect(normalizeGlobalState({})).toEqual({ globalTabs: [], globalScopeOverrides: {} });
    expect(
      normalizeGlobalState({
        globalTabs: ['plugin:radio:player', 'files', 3, 'plugin:radio:player', 'plugin:tg:chat'],
        globalScopeOverrides: {
          'plugin:radio:player': 'session',
          'plugin:tg:chat': 'global',
          'plugin:bad:x': 'all',
          files: 'global',
        },
      })
    ).toEqual({
      globalTabs: ['plugin:radio:player', 'plugin:tg:chat'],
      globalScopeOverrides: { 'plugin:radio:player': 'session', 'plugin:tg:chat': 'global' },
    });
    expect(normalizeGlobalState({ globalTabs: 'x', globalScopeOverrides: [] })).toEqual({
      globalTabs: [],
      globalScopeOverrides: {},
    });
  });
});
