import { beforeEach, describe, expect, it } from 'vitest';
import {
  closeSettings,
  openSettings,
  setSettingsCategory,
  setSettingsMobileDetail,
  settingsHistoryDepth,
  toggleSettings,
  useAppViewStore,
} from './appView';

const initial = useAppViewStore.getState();
const state = () => useAppViewStore.getState();

beforeEach(() => useAppViewStore.setState(initial, true));

describe('设置路由', () => {
  it('默认停在工作区；打开后进设置，关闭回工作区', () => {
    expect(state().settings).toBeNull();
    openSettings();
    expect(state().settings).toEqual({ link: null, linkSeq: 0 });
    closeSettings();
    expect(state().settings).toBeNull();
  });

  it('⌘, 连按：奇数次停在设置，偶数次回工作区', () => {
    for (let i = 0; i < 5; i += 1) toggleSettings();
    expect(state().settings).not.toBeNull();
    toggleSettings();
    expect(state().settings).toBeNull();
  });

  it('带深链打开：分区与行落到链接，重复同一链接也会再定位一次', () => {
    openSettings({ category: 'logs', rowId: 'logs.root' });
    const first = state().settings;
    expect(first?.link).toEqual({ category: 'logs', rowId: 'logs.root' });
    expect(state().lastCategory).toBe('logs');
    openSettings({ category: 'logs', rowId: 'logs.root' });
    expect(state().settings?.linkSeq).toBe((first?.linkSeq ?? 0) + 1);
  });

  it('设置已开时不带链接再打开不会丢掉当前分区', () => {
    openSettings({ category: 'mcp', rowId: 'mcp.root' });
    const before = state().settings;
    openSettings();
    expect(state().settings).toEqual(before);
  });

  it('再次打开回到上次停留的分区', () => {
    openSettings();
    setSettingsCategory('appearance');
    closeSettings();
    openSettings();
    expect(state().lastCategory).toBe('appearance');
    expect(state().settings?.link).toBeNull();
  });
});

describe('窄屏两级与浏览器历史深度', () => {
  it('深链直接进分区详情；普通打开先看导航列表；关闭后清掉', () => {
    openSettings({ category: 'logs', rowId: 'logs.root' });
    expect(state().mobileDetail).toBe(true);
    closeSettings();
    expect(state().mobileDetail).toBe(false);
    openSettings();
    expect(state().mobileDetail).toBe(false);
  });

  it('深度：工作区 0，设置 1，窄屏分区详情 2；宽屏没有第二级', () => {
    expect(settingsHistoryDepth(state(), true)).toBe(0);
    openSettings();
    expect(settingsHistoryDepth(state(), true)).toBe(1);
    setSettingsMobileDetail(true);
    expect(settingsHistoryDepth(state(), true)).toBe(2);
    expect(settingsHistoryDepth(state(), false)).toBe(1);
  });
});
