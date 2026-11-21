import { describe, expect, it, vi } from 'vitest';
import { addSecretaryPanel, createSecretaryConsoleReveal } from './secretaryConsole';

function fakeDock(ids: string[] = []) {
  const focus = vi.fn();
  const panels = new Map(ids.map((id) => [id, { id, focus }]));
  const addPanel = vi.fn((options: { id: string }) => {
    panels.set(options.id, { id: options.id, focus });
  });
  const api = { getPanel: (id: string) => panels.get(id), addPanel };
  return {
    api: api as unknown as Parameters<typeof addSecretaryPanel>[0],
    panels,
    addPanel,
    focus,
  };
}

const visible = { secretary: true, open: true, active: true, ready: true };

describe('createSecretaryConsoleReveal', () => {
  it('秘书会话打开侧栏时放行一次', () => {
    const reveal = createSecretaryConsoleReveal();
    expect(reveal(visible)).toBe(true);
  });

  it('同一次打开期间重渲染、切走再切回都不再放行，不反复抢焦点', () => {
    const reveal = createSecretaryConsoleReveal();
    expect(reveal(visible)).toBe(true);
    expect(reveal(visible)).toBe(false);
    expect(reveal({ ...visible, active: false })).toBe(false);
    expect(reveal(visible)).toBe(false);
  });

  it('收起再打开会再放行一次，关掉的秘书面板会被补回', () => {
    const reveal = createSecretaryConsoleReveal();
    expect(reveal(visible)).toBe(true);
    expect(reveal({ ...visible, open: false })).toBe(false);
    expect(reveal(visible)).toBe(true);
  });

  it('dock 还没就绪或不是当前会话时先不放行，就绪后再放行', () => {
    const reveal = createSecretaryConsoleReveal();
    expect(reveal({ ...visible, ready: false })).toBe(false);
    expect(reveal({ ...visible, active: false })).toBe(false);
    expect(reveal(visible)).toBe(true);
  });

  it('普通会话打开侧栏不放行', () => {
    const reveal = createSecretaryConsoleReveal();
    expect(reveal({ ...visible, secretary: false })).toBe(false);
    expect(reveal({ ...visible, secretary: false })).toBe(false);
  });
});

describe('addSecretaryPanel', () => {
  it('没有秘书面板时新建一块', () => {
    const dock = fakeDock(['browser:a']);
    addSecretaryPanel(dock.api, 'c1', 'p1', '秘书');
    expect(dock.addPanel).toHaveBeenCalledWith({
      id: 'secretary',
      component: 'secretary',
      title: '秘书',
      params: { conversationId: 'c1', projectId: 'p1' },
    });
  });

  it('已有秘书面板时只切过去，不重复新建', () => {
    const dock = fakeDock(['secretary', 'browser:a']);
    addSecretaryPanel(dock.api, 'c1', 'p1', '秘书');
    addSecretaryPanel(dock.api, 'c1', 'p1', '秘书');
    expect(dock.addPanel).not.toHaveBeenCalled();
    expect(dock.focus).toHaveBeenCalledTimes(2);
    expect([...dock.panels.keys()].filter((id) => id === 'secretary')).toHaveLength(1);
  });
});
