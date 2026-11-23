import type { DockviewApi } from 'dockview-react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveSidePanelDockConversationId } from './sidePanelDockId';

const harness = vi.hoisted(() => ({
  uiByConversation: {} as Record<string, { open: boolean; width: number }>,
  setStateCalls: 0,
}));

vi.mock('@/stores/sessions', () => ({
  useSessionsStore: { getState: () => ({ activeId: 'dock', conversations: {} }) },
}));
vi.mock('@/stores/settings', () => ({
  useSettingsStore: { getState: () => ({ disabledBuiltinTools: [], projects: [] }) },
}));
vi.mock('@/stores/sidePanel', () => ({
  useSidePanelStore: {
    getState: () => ({
      uiByConversation: harness.uiByConversation,
      ensureOpen: vi.fn(),
      forgetConversation: vi.fn(),
    }),
    setState: (
      updater: (state: { uiByConversation: typeof harness.uiByConversation }) => {
        uiByConversation?: typeof harness.uiByConversation;
      }
    ) => {
      harness.setStateCalls += 1;
      const next = updater({ uiByConversation: harness.uiByConversation });
      if (next.uiByConversation) harness.uiByConversation = next.uiByConversation;
    },
  },
}));

import {
  bindSidePanelDock,
  disposeConversationResources,
  watchSidePanelAutoCollapse,
} from './sidePanelDock';
import { type TerminalInstance, terminalInstances } from './terminalInstances';

function fakeDock() {
  const panels: { id: string }[] = [];
  const listeners = new Set<(panel: { id: string }) => void>();
  const api = {
    panels,
    getPanel: (id: string) => panels.find((panel) => panel.id === id),
    addPanel: (opts: { id: string }) => {
      panels.push({ id: opts.id });
    },
    onDidRemovePanel: (listener: (panel: { id: string }) => void) => {
      listeners.add(listener);
      return { dispose: () => listeners.delete(listener) };
    },
  };
  return {
    api: api as unknown as DockviewApi,
    add: (id: string) => {
      panels.push({ id });
    },
    remove: (id: string) => {
      const index = panels.findIndex((panel) => panel.id === id);
      if (index < 0) return;
      const [panel] = panels.splice(index, 1);
      for (const listener of listeners) listener(panel);
    },
    /** 模拟 dockview fromJSON：先清空现有 panel（逐个触发 remove），再建已存布局里的 */
    restore: (ids: string[]) => {
      while (panels.length > 0) {
        const [panel] = panels.splice(0, 1);
        for (const listener of listeners) listener(panel);
      }
      for (const id of ids) panels.push({ id });
    },
    listenerCount: () => listeners.size,
  };
}

describe('resolveSidePanelDockConversationId', () => {
  it('普通会话用自身 id', () => {
    expect(resolveSidePanelDockConversationId({ parent: {} }, 'parent')).toBe('parent');
  });

  it('btw 会话落到父会话 dock，用户才能看见浏览器', () => {
    expect(
      resolveSidePanelDockConversationId(
        {
          parent: {},
          btw: { btwParentId: 'parent' },
        },
        'btw'
      )
    ).toBe('parent');
  });

  it('未知会话保持原 id', () => {
    expect(resolveSidePanelDockConversationId({}, 'missing')).toBe('missing');
  });
});

describe('watchSidePanelAutoCollapse 关完最后一个 tab 收起侧栏', () => {
  beforeEach(() => {
    vi.stubGlobal('window', {});
    disposeConversationResources('dock');
    harness.uiByConversation = { dock: { open: true, width: 400 } };
    harness.setStateCalls = 0;
  });

  it('还有其他 panel 时关掉一个，open 仍为 true', () => {
    const dock = fakeDock();
    dock.add('files');
    dock.add('terminal');
    bindSidePanelDock('dock', dock.api);
    watchSidePanelAutoCollapse('dock', dock.api);
    harness.setStateCalls = 0;

    dock.remove('terminal');

    expect(harness.uiByConversation.dock.open).toBe(true);
    expect(harness.setStateCalls).toBe(0);
  });

  it('关掉最后一个 panel 后 open 变为 false', () => {
    const dock = fakeDock();
    dock.add('files');
    bindSidePanelDock('dock', dock.api);
    watchSidePanelAutoCollapse('dock', dock.api);
    harness.setStateCalls = 0;

    dock.remove('files');

    expect(harness.uiByConversation.dock.open).toBe(false);
    expect(harness.setStateCalls).toBe(1);
  });

  it('已经收起时关掉最后一个 panel 不产生多余 setState', () => {
    harness.uiByConversation = { dock: { open: false, width: 400 } };
    const dock = fakeDock();
    dock.add('files');
    bindSidePanelDock('dock', dock.api);
    watchSidePanelAutoCollapse('dock', dock.api);
    harness.setStateCalls = 0;

    dock.remove('files');

    expect(harness.uiByConversation.dock.open).toBe(false);
    expect(harness.setStateCalls).toBe(0);
  });

  it('解绑后不再响应 panel 移除', () => {
    const dock = fakeDock();
    dock.add('files');
    bindSidePanelDock('dock', dock.api);
    watchSidePanelAutoCollapse('dock', dock.api);
    disposeConversationResources('dock');
    harness.uiByConversation = { dock: { open: true, width: 400 } };
    harness.setStateCalls = 0;

    dock.remove('files');

    expect(harness.uiByConversation.dock.open).toBe(true);
    expect(harness.setStateCalls).toBe(0);
    expect(dock.listenerCount()).toBe(0);
  });

  it('先补建面板、再恢复已存布局，侧栏保持打开；之后用户关掉最后一个 tab 仍收起', () => {
    const dock = fakeDock();
    bindSidePanelDock('dock', dock.api);
    dock.add('browser:pending');
    dock.restore(['files']);
    watchSidePanelAutoCollapse('dock', dock.api);

    expect(harness.uiByConversation.dock.open).toBe(true);
    expect(harness.setStateCalls).toBe(0);

    dock.remove('files');

    expect(harness.uiByConversation.dock.open).toBe(false);
  });
});

describe('disposeConversationResources 回收终端', () => {
  // 曾经异步 import 回收：同一会话的多个终端并发 import，测试结束后还在加载 xterm
  it('会话里每个终端都当场回收，不留异步尾巴', () => {
    vi.stubGlobal('window', {});
    const fakeTerminal = () => ({ term: { dispose: vi.fn() }, host: { remove: vi.fn() } });
    const t1 = fakeTerminal();
    const t2 = fakeTerminal();
    terminalInstances.set('term-1', t1 as unknown as TerminalInstance);
    terminalInstances.set('term-2', t2 as unknown as TerminalInstance);
    const dock = fakeDock();
    dock.add('files');
    dock.add('term-1');
    dock.add('term-2');
    bindSidePanelDock('dock', dock.api);

    disposeConversationResources('dock');

    expect(t1.term.dispose).toHaveBeenCalledOnce();
    expect(t1.host.remove).toHaveBeenCalledOnce();
    expect(t2.term.dispose).toHaveBeenCalledOnce();
    expect(t2.host.remove).toHaveBeenCalledOnce();
    expect(terminalInstances.size).toBe(0);
  });
});
