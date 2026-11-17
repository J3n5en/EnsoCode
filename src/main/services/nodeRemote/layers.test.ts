import { describe, expect, it } from 'vitest';
import { type ActiveNode, NodeLayers } from './layers';

function setup() {
  const created: string[] = [];
  const destroyed: string[] = [];
  const shown: (string | null)[] = [];
  const changes: ActiveNode[] = [];
  const layers = new NodeLayers<{ nodeId: string }>(
    {
      create: (nodeId) => {
        created.push(nodeId);
        return { nodeId };
      },
      show: (view) => shown.push(view?.nodeId ?? null),
      destroy: (view) => destroyed.push(view.nodeId),
    },
    (active) => changes.push(active)
  );
  return { layers, created, destroyed, shown, changes };
}

describe('NodeLayers', () => {
  it('启动在本机；首次切到节点才建该节点的界面层并显示', () => {
    const { layers, created, shown, changes } = setup();
    expect(layers.active).toBe('local');
    layers.switchTo('n1');
    expect(created).toEqual(['n1']);
    expect(shown).toEqual(['n1']);
    expect(layers.active).toBe('n1');
    expect(changes).toEqual(['n1']);
  });

  it('切回本机只隐藏节点层；再切回复用同一层，不重建', () => {
    const { layers, created, destroyed, shown, changes } = setup();
    layers.switchTo('n1');
    const first = layers.view('n1');
    layers.switchTo('local');
    layers.switchTo('n1');
    expect(created).toEqual(['n1']);
    expect(destroyed).toEqual([]);
    expect(layers.view('n1')).toBe(first);
    expect(shown).toEqual(['n1', null, 'n1']);
    expect(changes).toEqual(['n1', 'local', 'n1']);
  });

  it('重复切到当前层仍重新显示（取回焦点），但不重复通知', () => {
    const { layers, shown, changes } = setup();
    layers.switchTo('n1');
    layers.switchTo('n1');
    expect(shown).toEqual(['n1', 'n1']);
    expect(changes).toEqual(['n1']);
  });

  it('删除正在看的节点：先回本机再销毁其界面层', () => {
    const { layers, destroyed, shown, changes } = setup();
    layers.switchTo('n1');
    layers.drop('n1');
    expect(layers.active).toBe('local');
    expect(shown.at(-1)).toBeNull();
    expect(destroyed).toEqual(['n1']);
    expect(changes).toEqual(['n1', 'local']);
    layers.switchTo('n1');
    expect(layers.view('n1')).toEqual({ nodeId: 'n1' });
  });

  it('删除后台节点只销毁它，可见层不变；没建过层的节点无事发生', () => {
    const { layers, destroyed, changes } = setup();
    layers.switchTo('n1');
    layers.switchTo('n2');
    layers.drop('n1');
    layers.drop('n3');
    expect(layers.active).toBe('n2');
    expect(destroyed).toEqual(['n1']);
    expect(changes).toEqual(['n1', 'n2']);
  });

  it('窗口关闭：销毁全部节点层并回到本机', () => {
    const { layers, destroyed, changes } = setup();
    layers.switchTo('n1');
    layers.switchTo('n2');
    layers.reset();
    expect(destroyed.sort()).toEqual(['n1', 'n2']);
    expect(layers.active).toBe('local');
    expect(layers.view('n1')).toBeUndefined();
    expect(changes.at(-1)).toBe('local');
  });
});
