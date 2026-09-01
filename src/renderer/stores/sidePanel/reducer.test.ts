import type { SidePanelTab } from '@shared/types/sidePanel';
import { describe, expect, it } from 'vitest';
import { addTab, closeTab, emptyLayout, moveTab, selectTab } from './reducer';

const term = (id: string): SidePanelTab => ({ id, kind: 'terminal', title: `终端 ${id}` });

describe('sidePanel reducer', () => {
  it('新建 tab 追加到该会话末尾并成为激活项', () => {
    let layout = emptyLayout();
    layout = addTab(layout, 'conv-a', term('t1'));
    layout = addTab(layout, 'conv-a', term('t2'));
    expect(layout.tabs['conv-a'].map((t) => t.id)).toEqual(['t1', 't2']);
    expect(layout.active['conv-a']).toBe('t2');
  });

  it('不同会话的 tab 互相隔离', () => {
    let layout = emptyLayout();
    layout = addTab(layout, 'conv-a', term('t1'));
    layout = addTab(layout, 'conv-b', term('t2'));
    expect(layout.tabs['conv-a'].map((t) => t.id)).toEqual(['t1']);
    expect(layout.tabs['conv-b'].map((t) => t.id)).toEqual(['t2']);
    expect(layout.active['conv-a']).toBe('t1');
    expect(layout.active['conv-b']).toBe('t2');
  });

  it('关闭激活 tab 时激活项回落到右邻，无右邻回落左邻', () => {
    let layout = emptyLayout();
    layout = addTab(layout, 'c', term('t1'));
    layout = addTab(layout, 'c', term('t2'));
    layout = addTab(layout, 'c', term('t3'));
    layout = selectTab(layout, 'c', 't2');
    layout = closeTab(layout, 'c', 't2');
    expect(layout.active['c']).toBe('t3');
    layout = closeTab(layout, 'c', 't3');
    expect(layout.active['c']).toBe('t1');
  });

  it('关闭非激活 tab 不改变激活项', () => {
    let layout = emptyLayout();
    layout = addTab(layout, 'c', term('t1'));
    layout = addTab(layout, 'c', term('t2'));
    layout = closeTab(layout, 'c', 't1');
    expect(layout.active['c']).toBe('t2');
  });

  it('关闭最后一个 tab 后该会话回到空态', () => {
    let layout = emptyLayout();
    layout = addTab(layout, 'c', term('t1'));
    layout = closeTab(layout, 'c', 't1');
    expect(layout.tabs['c'] ?? []).toEqual([]);
    expect(layout.active['c']).toBeUndefined();
  });

  it('selectTab 只接受存在的 tab', () => {
    let layout = emptyLayout();
    layout = addTab(layout, 'c', term('t1'));
    layout = selectTab(layout, 'c', 'ghost');
    expect(layout.active['c']).toBe('t1');
  });

  it('拖拽排序：把 active 移到 over 的位置', () => {
    let layout = emptyLayout();
    layout = addTab(layout, 'c', term('t1'));
    layout = addTab(layout, 'c', term('t2'));
    layout = addTab(layout, 'c', term('t3'));
    layout = moveTab(layout, 'c', 't1', 't3');
    expect(layout.tabs['c'].map((t) => t.id)).toEqual(['t2', 't3', 't1']);
  });

  it('拖拽排序：目标不存在或同一 tab 时不变', () => {
    let layout = emptyLayout();
    layout = addTab(layout, 'c', term('t1'));
    layout = addTab(layout, 'c', term('t2'));
    const same = moveTab(layout, 'c', 't1', 't1');
    expect(same.tabs['c'].map((t) => t.id)).toEqual(['t1', 't2']);
    const ghost = moveTab(layout, 'c', 't1', 'ghost');
    expect(ghost.tabs['c'].map((t) => t.id)).toEqual(['t1', 't2']);
  });

  it('脏输入：对不存在的会话关闭/排序不崩', () => {
    const layout = emptyLayout();
    expect(closeTab(layout, 'nope', 't1')).toEqual(layout);
    expect(moveTab(layout, 'nope', 't1', 't2')).toEqual(layout);
  });
});
