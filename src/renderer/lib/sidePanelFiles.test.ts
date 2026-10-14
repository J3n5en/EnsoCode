import type { DockviewApi } from 'dockview-react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const harness = vi.hoisted(() => ({
  conversations: {} as Record<string, { projectId: string; btwParentId?: string }>,
  ensureOpen: vi.fn(),
}));

vi.mock('@/stores/sessions', () => ({
  useSessionsStore: {
    getState: () => ({ activeId: 'parent', conversations: harness.conversations }),
  },
}));
vi.mock('@/stores/settings', () => ({
  useSettingsStore: { getState: () => ({ disabledBuiltinTools: [], projects: [] }) },
}));
vi.mock('@/stores/sidePanel', () => ({
  useSidePanelStore: {
    getState: () => ({ ensureOpen: harness.ensureOpen, forgetConversation: vi.fn() }),
  },
}));
vi.mock('@/lib/terminalRegistry', () => ({ releaseTerminal: vi.fn() }));

import {
  bindSidePanelDock,
  disposeConversationResources,
  openSidePanelFile,
  registerFilesOpener,
} from './sidePanelDock';

function fakeDock() {
  const panels: { id: string; params: unknown; focus: ReturnType<typeof vi.fn> }[] = [];
  const api = {
    panels,
    getPanel: (id: string) => panels.find((panel) => panel.id === id),
    addPanel: (opts: { id: string; params: unknown }) => {
      panels.push({ id: opts.id, params: opts.params, focus: vi.fn() });
    },
  };
  return { api: api as unknown as DockviewApi, panels };
}

beforeEach(() => {
  vi.stubGlobal('window', {});
  for (const id of ['parent', 'btw', 'late']) disposeConversationResources(id);
  harness.conversations = {
    parent: { projectId: 'p1' },
    btw: { projectId: 'p1', btwParentId: 'parent' },
    late: { projectId: 'p2' },
  };
  harness.ensureOpen.mockClear();
});

describe('openSidePanelFile', () => {
  it('Files 视图已挂载：直接打开文件并聚焦 Files 面板', () => {
    const { api, panels } = fakeDock();
    bindSidePanelDock('parent', api);
    api.addPanel({ id: 'files', component: 'files' });
    const open = vi.fn();
    registerFilesOpener('parent', open);

    openSidePanelFile('parent', 'src/a.ts');

    expect(open).toHaveBeenCalledWith('src/a.ts');
    expect(panels[0].focus).toHaveBeenCalled();
    expect(harness.ensureOpen).toHaveBeenCalledWith('parent');
  });

  it('Files 面板未开：新建面板，视图挂载后补开文件且只补一次', () => {
    const { api, panels } = fakeDock();
    bindSidePanelDock('parent', api);

    openSidePanelFile('parent', 'src/a.ts');

    expect(panels.map((panel) => [panel.id, panel.params])).toEqual([
      ['files', { conversationId: 'parent', projectId: 'p1' }],
    ]);
    const open = vi.fn();
    const unregister = registerFilesOpener('parent', open);
    expect(open).toHaveBeenCalledWith('src/a.ts');
    unregister();
    const again = vi.fn();
    registerFilesOpener('parent', again);
    expect(again).not.toHaveBeenCalled();
  });

  it('btw 会话里的文件在父会话 dock 打开', () => {
    const { api } = fakeDock();
    bindSidePanelDock('parent', api);
    const open = vi.fn();
    registerFilesOpener('parent', open);

    openSidePanelFile('btw', 'src/b.ts');

    expect(open).toHaveBeenCalledWith('src/b.ts');
    expect(harness.ensureOpen).toHaveBeenCalledWith('parent');
  });

  it('带行号：已挂载时直接带行号打开，未挂载时补开也带行号', () => {
    const { api } = fakeDock();
    bindSidePanelDock('parent', api);
    openSidePanelFile('parent', 'src/a.ts', 107);
    const open = vi.fn();
    registerFilesOpener('parent', open);
    expect(open).toHaveBeenLastCalledWith('src/a.ts', 107);

    openSidePanelFile('parent', 'src/b.ts', 3);
    expect(open).toHaveBeenLastCalledWith('src/b.ts', 3);
  });

  it('dock 尚未挂载：挂载后补建 Files 面板', async () => {
    openSidePanelFile('late', 'README.md');
    const { api, panels } = fakeDock();
    bindSidePanelDock('late', api);
    await Promise.resolve();

    expect(panels.map((panel) => [panel.id, panel.params])).toEqual([
      ['files', { conversationId: 'late', projectId: 'p2' }],
    ]);
  });

  it('Markdown 预览意图在冷挂载与 btw 父路由中保留；行号仍保持源码', () => {
    openSidePanelFile('btw', 'README.md', undefined, 'markdown');
    const open = vi.fn();
    registerFilesOpener('parent', open);
    expect(open).toHaveBeenLastCalledWith('README.md', undefined, 'markdown');
    openSidePanelFile('btw', 'README.md', 9);
    expect(open).toHaveBeenLastCalledWith('README.md', 9);
  });
});
