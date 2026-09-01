import type { SidePanelTab } from '@shared/types/sidePanel';
import { describe, expect, it } from 'vitest';
import {
  addTab,
  closeTab,
  emptyLayout,
  groupOf,
  moveTab,
  moveTabToGroup,
  selectTab,
} from './reducer';

const term = (id: string): SidePanelTab => ({ id, kind: 'terminal', title: id });

function threeTabs() {
  let layout = emptyLayout();
  layout = addTab(layout, 'c', term('t1'));
  layout = addTab(layout, 'c', term('t2'));
  layout = addTab(layout, 'c', term('t3'));
  return layout;
}

describe('sidePanel 分屏', () => {
  it('拖 tab 到分屏区:移入下组末尾并激活,主组激活回落', () => {
    let layout = threeTabs(); // active = t3
    layout = moveTabToGroup(layout, 'c', 't3', 'split');
    expect(layout.tabs['c'].map((t) => t.id)).toEqual(['t1', 't2']);
    expect(layout.splitTabs['c'].map((t) => t.id)).toEqual(['t3']);
    expect(layout.splitActive['c']).toBe('t3');
    expect(layout.active['c']).toBe('t2');
  });

  it('把下组最后一个 tab 拖回主组:取消分屏', () => {
    let layout = threeTabs();
    layout = moveTabToGroup(layout, 'c', 't3', 'split');
    layout = moveTabToGroup(layout, 'c', 't3', 'main');
    expect(layout.tabs['c'].map((t) => t.id)).toEqual(['t1', 't2', 't3']);
    expect(layout.splitTabs['c'] ?? []).toEqual([]);
    expect(layout.splitActive['c']).toBeUndefined();
    expect(layout.active['c']).toBe('t3');
  });

  it('关闭下组最后一个 tab:取消分屏', () => {
    let layout = threeTabs();
    layout = moveTabToGroup(layout, 'c', 't3', 'split');
    layout = closeTab(layout, 'c', 't3');
    expect(layout.splitTabs['c'] ?? []).toEqual([]);
    expect(layout.splitActive['c']).toBeUndefined();
    expect(layout.tabs['c'].map((t) => t.id)).toEqual(['t1', 't2']);
  });

  it('已在目标组时 moveTabToGroup 不变', () => {
    const layout = threeTabs();
    expect(moveTabToGroup(layout, 'c', 't1', 'main')).toEqual(layout);
  });

  it('跨组 moveTab:拖到另一组的 tab 位置,插入其前并保持源组激活回落', () => {
    let layout = threeTabs();
    layout = moveTabToGroup(layout, 'c', 't1', 'split');
    layout = moveTabToGroup(layout, 'c', 't2', 'split'); // split: [t1,t2] main: [t3]
    layout = moveTab(layout, 'c', 't3', 't1'); // main 的 t3 拖到 split 的 t1 位置
    expect(layout.tabs['c'] ?? []).toEqual([]);
    expect(layout.splitTabs['c'].map((t) => t.id)).toEqual(['t3', 't1', 't2']);
    expect(layout.active['c']).toBeUndefined();
  });

  it('selectTab 只影响 tab 所在组的激活项', () => {
    let layout = threeTabs();
    layout = moveTabToGroup(layout, 'c', 't3', 'split');
    layout = selectTab(layout, 'c', 't1');
    expect(layout.active['c']).toBe('t1');
    expect(layout.splitActive['c']).toBe('t3');
  });

  it('groupOf 判定所在组', () => {
    let layout = threeTabs();
    layout = moveTabToGroup(layout, 'c', 't3', 'split');
    expect(groupOf(layout, 'c', 't1')).toBe('main');
    expect(groupOf(layout, 'c', 't3')).toBe('split');
    expect(groupOf(layout, 'c', 'ghost')).toBeNull();
  });

  it('脏输入:不存在的 tab/会话移动分组不崩', () => {
    const layout = emptyLayout();
    expect(moveTabToGroup(layout, 'nope', 't1', 'split')).toEqual(layout);
  });
});
