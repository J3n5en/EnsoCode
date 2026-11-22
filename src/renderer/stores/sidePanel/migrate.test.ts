import { describe, expect, it } from 'vitest';
import { migrateSidePanelState, SIDE_PANEL_VERSION, splitLegacySnapshots } from './migrate';

describe('splitLegacySnapshots', () => {
  it('当前持久化版本为 5', () => {
    expect(SIDE_PANEL_VERSION).toBe(5);
  });

  it('版本低于 2 时重置旧状态且不迁移快照', () => {
    expect(splitLegacySnapshots({ snapshotsByConversation: { c1: { a: 'old' } } }, 1)).toEqual({
      state: { uiByConversation: {}, layouts: {} },
      snapshots: {},
    });
  });

  it('版本 2 迁移布局和变更模式并重置会话界面', () => {
    const persisted = {
      uiByConversation: { c1: { tab: 'changes' } },
      layouts: { c1: 'wide' },
      changesModeByConversation: { c1: 'all' },
    };
    expect(splitLegacySnapshots(persisted, 2).state).toEqual({
      uiByConversation: {},
      layouts: { c1: 'wide' },
      changesModeByConversation: { c1: 'all' },
    });
  });

  it('版本 3 保留会话界面并为缺失字段补空对象', () => {
    expect(splitLegacySnapshots({ uiByConversation: { c1: { tab: 'files' } } }, 3).state).toEqual({
      uiByConversation: { c1: { tab: 'files' } },
      layouts: {},
      changesModeByConversation: {},
    });
  });

  it('版本 2 或 3 只迁移普通对象中的字符串快照并丢弃空会话', () => {
    class Snapshot {
      file = 'old';
    }
    const snapshotsByConversation = {
      kept: { 'a.ts': 'old', count: 1, empty: '' },
      empty: { count: 1 },
      array: ['old'],
      nil: null,
      text: 'old',
      constructed: new Snapshot(),
    };
    for (const version of [2, 3]) {
      expect(splitLegacySnapshots({ snapshotsByConversation }, version).snapshots).toEqual({
        kept: { 'a.ts': 'old', empty: '' },
      });
    }
  });

  it('版本 4 及以上移除意外残留的快照字段并保留其余状态', () => {
    const persisted = {
      layouts: { c1: 'wide' },
      custom: 1,
      snapshotsByConversation: { c1: { a: 'old' } },
    };
    for (const version of [4, 5]) {
      expect(splitLegacySnapshots(persisted, version)).toEqual({
        state: { layouts: { c1: 'wide' }, custom: 1 },
        snapshots: {},
      });
    }
  });

  it('持久化值不是对象时按各版本安全返回空状态', () => {
    expect(splitLegacySnapshots(null, 3)).toEqual({
      state: { uiByConversation: {}, layouts: {}, changesModeByConversation: {} },
      snapshots: {},
    });
    expect(splitLegacySnapshots('bad', 4)).toEqual({ state: {}, snapshots: {} });
  });
});

describe('migrateSidePanelState v4 → v5', () => {
  it('只加全局字段，老数据（布局、固定标签、开关、宽度、全屏记忆）原样保留', () => {
    const v4 = {
      lastWidth: 520,
      uiByConversation: { c1: { open: true, width: 520 }, c2: { open: false, width: 400 } },
      fullscreenByConversation: { c1: true },
      layouts: { c1: { grid: {}, panels: { files: {} } } },
      pinnedTabs: ['files', 'plugin:notes:board'],
      changesModeByConversation: { c1: 'git' },
    };
    const { state } = migrateSidePanelState(v4, 4);
    expect(state).toEqual({ ...v4, globalTabs: [], globalScopeOverrides: {} });
  });

  it('v5 读回时清洗脏的全局字段', () => {
    const { state } = migrateSidePanelState(
      { layouts: {}, globalTabs: ['plugin:a:b', 'files'], globalScopeOverrides: 'x' },
      5
    );
    expect(state.globalTabs).toEqual(['plugin:a:b']);
    expect(state.globalScopeOverrides).toEqual({});
  });

  it('更老的版本照旧剥快照，再补全局字段', () => {
    const { state, snapshots } = migrateSidePanelState(
      { layouts: { c1: 'x' }, snapshotsByConversation: { c1: { 'a.ts': 'old' } } },
      3
    );
    expect(snapshots).toEqual({ c1: { 'a.ts': 'old' } });
    expect(state).toMatchObject({ layouts: { c1: 'x' }, globalTabs: [] });
  });
});
