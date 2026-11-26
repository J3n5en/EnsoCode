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
import type { CollapsedActiveProject, CollapsedProjectSession } from './collapsedActiveProjects';

// settings store 的 persist rehydrate 会在 unmount 后异步触碰真实 document；i18n 只依赖 t
vi.mock('@/i18n', () => ({
  useI18n: () => ({ t: (key: string) => key, locale: 'en' }),
}));

const entry: CollapsedActiveProject = {
  projectId: 'p1',
  conversationId: 'c1',
  title: 'Fix the rail',
};
const projects = [{ id: 'p1', name: 'Alpha', path: '/tmp/alpha' }];

const session = (overrides?: Partial<CollapsedProjectSession>): CollapsedProjectSession => ({
  conversationId: 'c1',
  title: 'Fix the rail',
  tone: 'running',
  activity: 10,
  ...overrides,
});

const oneSession = { p1: [session()] };
const twoSessions = {
  p1: [
    session({ conversationId: 'c1', title: 'Fix the rail', activity: 20 }),
    session({ conversationId: 'c2', title: 'Second chat', tone: 'idle', activity: 10 }),
  ],
};

describe('CollapsedActiveProjectRail', () => {
  it('没有进行中项目时不占位', () => {
    expect(
      renderToStaticMarkup(
        createElement(CollapsedActiveProjectRail, {
          entries: [],
          projects,
          sessionsByProject: {},
          onOpen: () => {},
          onOpenSession: () => {},
        })
      )
    ).toBe('');
  });

  it('渲染 26px 头像、运行绿点和项目名加会话标题', () => {
    const markup = renderToStaticMarkup(
      createElement(CollapsedActiveProjectRail, {
        entries: [entry],
        projects,
        sessionsByProject: oneSession,
        onOpen: () => {},
        onOpenSession: () => {},
      })
    );
    expect(COLLAPSED_ACTIVE_ICON_SIZE).toBe(26);
    expect(markup).toContain('data-enso="collapsed-active-project"');
    expect(markup).toContain('data-project-id="p1"');
    expect(markup).toContain('data-enso="project-icon"');
    expect(markup).toContain('width:26px');
    expect(markup).toContain('bg-emerald-500');
    expect(markup).toContain('title="Alpha · Fix the rail"');
  });

  it('单会话项目不显示数字角标，多会话项目显示会话数', () => {
    const single = renderToStaticMarkup(
      createElement(CollapsedActiveProjectRail, {
        entries: [entry],
        projects,
        sessionsByProject: oneSession,
        onOpen: () => {},
        onOpenSession: () => {},
      })
    );
    expect(single).toContain('data-enso="collapsed-running-dot"');
    expect(single).not.toContain('data-enso="collapsed-session-badge"');

    const multiple = renderToStaticMarkup(
      createElement(CollapsedActiveProjectRail, {
        entries: [entry],
        projects,
        sessionsByProject: twoSessions,
        onOpen: () => {},
        onOpenSession: () => {},
      })
    );
    expect(multiple).toContain('data-enso="collapsed-session-badge"');
    expect(multiple).toContain('>2</span>');
    expect(multiple).not.toContain('data-enso="collapsed-running-dot"');
  });

  it('活跃会话数超过 9 时角标显示 9+', () => {
    const many = {
      p1: Array.from({ length: 11 }, (_, index) =>
        session({ conversationId: `c${index}`, activity: index })
      ),
    };
    const markup = renderToStaticMarkup(
      createElement(CollapsedActiveProjectRail, {
        entries: [entry],
        projects,
        sessionsByProject: many,
        onOpen: () => {},
        onOpenSession: () => {},
      })
    );
    expect(markup).toContain('>9+</span>');
  });
});

describe('CollapsedActiveProjectRail 点击', () => {
  let container: HTMLElement;
  let root: Root;

  beforeEach(() => {
    const dom = parseHTML('<html><body><div id="root"></div></body></html>');
    vi.stubGlobal('window', dom.window);
    vi.stubGlobal('document', dom.document);
    vi.stubGlobal('Element', dom.window.Element);
    vi.stubGlobal('HTMLElement', dom.window.HTMLElement);
    vi.stubGlobal('Node', dom.window.Node);
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
        createElement(CollapsedActiveProjectRail, {
          entries: [entry],
          projects,
          sessionsByProject: oneSession,
          onOpen,
          onOpenSession: () => {},
        })
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
