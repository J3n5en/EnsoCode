import { parseHTML } from 'linkedom';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useProjectIconsStore } from '@/stores/projectIcons';
import {
  COLLAPSED_ACTIVE_ICON_SIZE,
  CollapsedActiveProjectRail,
} from './CollapsedActiveProjectRail';
import type { CollapsedActiveProject } from './collapsedActiveProjects';

const entry: CollapsedActiveProject = {
  projectId: 'p1',
  conversationId: 'c1',
  title: 'Fix the rail',
};
const projects = [{ id: 'p1', name: 'Alpha', path: '/tmp/alpha' }];

describe('CollapsedActiveProjectRail', () => {
  it('没有进行中项目时不占位', () => {
    expect(
      renderToStaticMarkup(
        createElement(CollapsedActiveProjectRail, { entries: [], projects, onOpen: () => {} })
      )
    ).toBe('');
  });

  it('渲染 26px 头像、运行绿点和项目名加会话标题', () => {
    const markup = renderToStaticMarkup(
      createElement(CollapsedActiveProjectRail, { entries: [entry], projects, onOpen: () => {} })
    );
    expect(COLLAPSED_ACTIVE_ICON_SIZE).toBe(26);
    expect(markup).toContain('data-enso="collapsed-active-project"');
    expect(markup).toContain('data-project-id="p1"');
    expect(markup).toContain('data-enso="project-icon"');
    expect(markup).toContain('width:26px');
    expect(markup).toContain('bg-emerald-500');
    expect(markup).toContain('title="Alpha · Fix the rail"');
  });
});

describe('CollapsedActiveProjectRail 点击', () => {
  let container: HTMLElement;
  let root: Root;

  beforeEach(() => {
    const dom = parseHTML('<html><body><div id="root"></div></body></html>');
    vi.stubGlobal('window', dom.window);
    vi.stubGlobal('document', dom.document);
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    Object.assign(dom.window, {
      electronAPI: {
        projects: { getIcon: vi.fn().mockResolvedValue({ revision: '', kind: 'none' }) },
      },
    });
    useProjectIconsStore.setState({ icons: {}, pending: new Set() });
    container = dom.document.getElementById('root') as unknown as HTMLElement;
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    vi.unstubAllGlobals();
  });

  it('点击头像把该项目条目交给打开逻辑', async () => {
    const onOpen = vi.fn();
    await act(async () => {
      root.render(
        createElement(CollapsedActiveProjectRail, { entries: [entry], projects, onOpen })
      );
    });
    const button = container.querySelector(
      '[data-enso="collapsed-active-project"]'
    ) as HTMLButtonElement;
    await act(async () => {
      button.click();
    });
    expect(onOpen).toHaveBeenCalledExactlyOnceWith(entry);
  });
});
