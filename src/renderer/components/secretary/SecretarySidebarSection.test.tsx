import type { SecretaryState } from '@shared/types/secretary';
import { parseHTML } from 'linkedom';
import { act, type ReactElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/i18n', () => ({ useI18n: () => ({ t: (key: string) => `[${key}]` }) }));
vi.mock('@/components/ui/context-menu', async () => {
  const { cloneElement, createContext, useContext, useState } = await import('react');
  const State = createContext({ open: false, show: () => {} });
  return {
    ContextMenu: ({ children }: { children: ReactNode }) => {
      const [open, setOpen] = useState(false);
      return (
        <State.Provider value={{ open, show: () => setOpen(true) }}>{children}</State.Provider>
      );
    },
    ContextMenuTrigger: ({ render }: { render: ReactElement }) => {
      const { show } = useContext(State);
      return cloneElement(render as ReactElement<{ onContextMenu: (event: Event) => void }>, {
        onContextMenu: (event: Event) => {
          event.preventDefault();
          show();
        },
      });
    },
    ContextMenuPopup: ({ children }: { children: ReactNode }) =>
      useContext(State).open ? <span role="menu">{children}</span> : null,
    ContextMenuItem: ({ children, onClick }: { children: ReactNode; onClick: () => void }) => (
      <button type="button" role="menuitem" onClick={onClick}>
        {children}
      </button>
    ),
    ContextMenuSeparator: () => null,
  };
});

import {
  SecretaryCollapsedButton,
  SecretarySidebarSection,
  secretarySectionView,
  sidebarProjects,
} from './SecretarySidebarSection';

const state = (over: Partial<SecretaryState> = {}): SecretaryState => ({
  enabled: true,
  projectId: 'sec',
  profile: null,
  persona: '',
  board: { needsYou: [], running: [], done: [], todos: [] },
  proposals: {},
  ...over,
});

const t = (key: string) => `[${key}]`;

let root: Root;
let container: HTMLElement;

const view = (over: Partial<SecretaryState> = {}) => {
  const result = secretarySectionView(state(over), t);
  if (!result) throw new Error('missing view');
  return result;
};

async function render(node: ReactElement) {
  await act(async () => {
    root.render(node);
  });
}

function click(selector: string) {
  const node = container.querySelector(selector);
  expect(node, selector).not.toBeNull();
  act(() => {
    (node as unknown as HTMLElement).click();
  });
}

function menuItem(label: string): HTMLElement | undefined {
  return [...container.querySelectorAll('[role="menuitem"]')].find(
    (node) => node.textContent === label
  ) as HTMLElement | undefined;
}

beforeEach(() => {
  const dom = parseHTML('<html><body><div id="root"></div></body></html>');
  vi.stubGlobal('window', dom.window);
  vi.stubGlobal('document', dom.document);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  container = dom.document.getElementById('root') as unknown as HTMLElement;
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  vi.unstubAllGlobals();
});

describe('secretarySectionView', () => {
  it('开关关掉时整块不出现', () => {
    expect(secretarySectionView(state({ enabled: false }), t)).toBeNull();
  });

  it('未完成初次设置时显示默认名「秘书」', () => {
    expect(view()).toEqual({ name: '[Secretary]', needsYou: 0, configured: false });
  });

  it('已设置时用档案名与头像色，角标取需要你处理的条数', () => {
    const board = state().board;
    const result = secretarySectionView(
      state({
        profile: {
          version: 1,
          name: '小安',
          avatar: { color: '#8b7bff' },
          autonomy: 'ask-first',
          autoApproveProjectIds: [],
          visibleProjectIds: 'all',
          dispatchModel: { mode: 'project' },
          dispatchWorktree: 'auto',
          maxRunningDispatches: 3,
          replyLanguage: 'ui',
          style: 'concise',
          notify: 'needs-user',
          updatedAt: 1,
        },
        board: {
          ...board,
          needsYou: [{ kind: 'proposal', proposal: {} as never }],
        },
      }),
      t
    );
    expect(result).toEqual({ name: '小安', needsYou: 1, configured: true, color: '#8b7bff' });
  });
});

describe('sidebarProjects', () => {
  it('秘书是置顶伪项目，不进普通项目列表', () => {
    const projects = [
      { id: 'a', kind: 'local' as const },
      { id: 'sec', kind: 'secretary' as const },
      { id: 'scratch', kind: 'scratch' as const },
    ];
    expect(sidebarProjects(projects).map((project) => project.id)).toEqual(['a']);
  });
});

describe('SecretarySidebarSection', () => {
  const actions = () => ({
    onToggleFold: vi.fn(),
    onOpen: vi.fn(),
    onNewConversation: vi.fn(),
    onOpenSettings: vi.fn(),
    onReset: vi.fn(),
  });

  it('未设置时显示默认名，点击整行进欢迎页，行内只有 ＋ 与 ⚙', async () => {
    const handlers = actions();
    await render(
      <SecretarySidebarSection view={view()} folded={false} {...handlers}>
        <div data-slot="conversation-row">child</div>
      </SecretarySidebarSection>
    );
    expect(container.textContent).toContain('[Secretary]');
    expect(container.querySelector('[data-enso="secretary-badge"]')).toBeNull();
    expect(container.querySelectorAll('[data-enso="secretary-action"]')).toHaveLength(2);
    expect(container.querySelector('[data-slot="conversation-row"]')).not.toBeNull();
    click('[data-enso="secretary-open"]');
    expect(handlers.onOpen).toHaveBeenCalledTimes(1);
    click('[data-enso="secretary-action"][data-action="new"]');
    expect(handlers.onNewConversation).toHaveBeenCalledTimes(1);
    click('[data-enso="secretary-action"][data-action="settings"]');
    expect(handlers.onOpenSettings).toHaveBeenCalledTimes(1);
  });

  it('需要你处理的数量显示为角标', async () => {
    const handlers = actions();
    await render(
      <SecretarySidebarSection view={{ ...view(), needsYou: 3 }} folded={false} {...handlers}>
        {null}
      </SecretarySidebarSection>
    );
    expect(container.querySelector('[data-enso="secretary-badge"]')?.textContent).toBe('3');
  });

  it('折叠后隐藏会话行，仍保留伪项目行与虚线分隔', async () => {
    const handlers = actions();
    await render(
      <SecretarySidebarSection view={view()} folded {...handlers}>
        <div data-slot="conversation-row">child</div>
      </SecretarySidebarSection>
    );
    expect(container.querySelector('[data-slot="conversation-row"]')).toBeNull();
    expect(container.querySelector('[data-enso="secretary-row"]')).not.toBeNull();
    expect(container.querySelector('[data-enso="secretary-divider"]')).not.toBeNull();
    click('[data-enso="secretary-fold"]');
    expect(handlers.onToggleFold).toHaveBeenCalledTimes(1);
  });

  it('右键只有新会话、设置、重新设置秘书', async () => {
    const handlers = actions();
    await render(
      <SecretarySidebarSection view={view()} folded={false} {...handlers}>
        {null}
      </SecretarySidebarSection>
    );
    const row = container.querySelector('[data-enso="secretary-row"]');
    await act(async () => {
      row?.dispatchEvent(new window.Event('contextmenu', { bubbles: true, cancelable: true }));
    });
    expect([...container.querySelectorAll('[role="menuitem"]')].map((n) => n.textContent)).toEqual([
      '[New conversation]',
      '[Secretary settings]',
      '[Re-run setup]',
    ]);
    act(() => menuItem('[Re-run setup]')?.click());
    expect(handlers.onReset).toHaveBeenCalledTimes(1);
  });
});

describe('SecretaryCollapsedButton', () => {
  it('折叠侧栏时保留图标与角标', async () => {
    const onClick = vi.fn();
    await render(
      <SecretaryCollapsedButton view={{ ...view(), name: '小安', needsYou: 2 }} onClick={onClick} />
    );
    const button = container.querySelector('[data-enso="secretary-collapsed"]');
    expect(button?.textContent).toContain('小');
    expect(container.querySelector('[data-enso="secretary-badge"]')?.textContent).toBe('2');
    act(() => (button as unknown as HTMLElement).click());
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});
