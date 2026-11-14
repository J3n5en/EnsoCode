import { REMOTE_LOCAL_IMAGE_PREFIX_KEY } from '@shared/localImage';
import type { SecretaryState } from '@shared/types/secretary';
import { parseHTML } from 'linkedom';
import { act, type ReactElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const translate = (key: string, params?: Record<string, string | number>) =>
  params
    ? key.replace(/\{\{(\w+)\}\}/g, (_, token: string) => String(params[token] ?? ''))
    : `[${key}]`;

vi.mock('@/i18n', () => ({ useI18n: () => ({ t: translate }) }));
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
  sidebarProjects,
} from './SecretarySidebarSection';
import { secretarySectionView } from './secretaryView';

const state = (over: Partial<SecretaryState> = {}): SecretaryState => ({
  enabled: true,
  projectId: 'sec',
  profile: null,
  persona: '',
  board: { needsYou: [], running: [], done: [], todos: [] },
  proposals: {},
  takeovers: [],
  ...over,
});

const t = translate;

let root: Root;
let container: HTMLElement;

const view = (over: Partial<SecretaryState> = {}) => {
  const result = secretarySectionView(state(over), t);
  if (!result) throw new Error('missing view');
  return result;
};

const profile: NonNullable<SecretaryState['profile']> = {
  version: 1,
  name: '小安',
  avatar: { color: '#8b7bff' },
  autonomy: 'ask-first',
  autoApproveProjectIds: [],
  takeoverScope: { mode: 'projects', projectIds: [] },
  visibleProjectIds: 'all',
  dispatchModel: { mode: 'project' },
  dispatchWorktree: 'auto',
  maxRunningDispatches: 3,
  patrolEnabled: true,
  patrolIntervalMinutes: 15,
  dispatchMuted: true,
  dispatchUnattended: true,
  replyLanguage: 'ui',
  style: 'concise',
  notify: 'needs-user',
  updatedAt: 1,
};

const sessionCard = (conversationId: string) => ({
  kind: 'session' as const,
  conversationId,
  projectId: 'p1',
  projectName: 'enso',
  title: '跑测试',
  state: 'running' as const,
  startedAt: 1,
  stateSince: 1,
  secretaryConversationId: 'sec',
});

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
    expect(view()).toEqual({ name: '[Secretary]', needsYou: 0, running: 0, configured: false });
  });

  it('已设置时用档案名与头像色，摘要取等你与在跑的条数', () => {
    const result = secretarySectionView(
      state({
        profile,
        board: {
          needsYou: [{ kind: 'proposal', proposal: {} as never }],
          running: [sessionCard('c1')],
          done: [],
          todos: [],
        },
      }),
      t
    );
    expect(result).toEqual({
      name: '小安',
      needsYou: 1,
      running: 1,
      configured: true,
      color: '#8b7bff',
    });
  });

  it('有图片时带上受控地址，配对页面走隧道前缀', () => {
    const withImage = secretarySectionView(
      state({
        profile: { ...profile, avatar: { color: '#ff00aa', imageVersion: 2 } },
      }),
      t
    );
    expect(withImage?.image).toBe('local-image://secretary-avatar/avatar.png?v=2');
    (globalThis as Record<string, unknown>)[REMOTE_LOCAL_IMAGE_PREFIX_KEY] = '/asset/li/';
    try {
      const remote = secretarySectionView(
        state({
          profile: { ...profile, avatar: { color: '#ff00aa', imageVersion: 2 } },
        }),
        t
      );
      expect(remote?.image?.startsWith('/asset/li/')).toBe(true);
      expect(decodeURIComponent(remote?.image ?? '')).toContain(
        'local-image://secretary-avatar/avatar.png?v=2'
      );
    } finally {
      delete (globalThis as Record<string, unknown>)[REMOTE_LOCAL_IMAGE_PREFIX_KEY];
    }
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

  it('未设置时显示默认名与设置提示，点击整行进欢迎页，行内只有 ＋ 与 ⚙', async () => {
    const handlers = actions();
    await render(
      <SecretarySidebarSection view={view()} folded={false} {...handlers}>
        <div data-slot="conversation-row">child</div>
      </SecretarySidebarSection>
    );
    expect(container.textContent).toContain('[Secretary]');
    expect(container.querySelector('[data-enso="secretary-summary"]')?.textContent).toBe(
      '[Click to finish setup]'
    );
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

  it('摘要显示等你与在跑的条数，等你那份用强调色', async () => {
    const handlers = actions();
    await render(
      <SecretarySidebarSection
        view={{ ...view(), configured: true, needsYou: 2, running: 3 }}
        folded={false}
        {...handlers}
      >
        {null}
      </SecretarySidebarSection>
    );
    expect(container.querySelector('[data-enso="secretary-summary"]')?.textContent).toBe(
      '2 waiting · 3 running'
    );
    const badge = container.querySelector('[data-enso="secretary-badge"]');
    expect(badge?.textContent).toBe('2 waiting');
    expect(badge?.className).toContain('text-warning');
  });

  it('没有任何活时只说一句没有在跑的活', async () => {
    const handlers = actions();
    await render(
      <SecretarySidebarSection view={{ ...view(), configured: true }} folded={false} {...handlers}>
        {null}
      </SecretarySidebarSection>
    );
    expect(container.querySelector('[data-enso="secretary-summary"]')?.textContent).toBe(
      '[Nothing running]'
    );
  });

  it('头像状态点：有等你用警告色，否则在跑用成功色，都没有就不显示', async () => {
    const handlers = actions();
    const tone = () =>
      container.querySelector('[data-enso="secretary-pip"]')?.getAttribute('data-tone') ?? null;
    await render(
      <SecretarySidebarSection
        view={{ ...view(), needsYou: 1, running: 1 }}
        folded={false}
        {...handlers}
      >
        {null}
      </SecretarySidebarSection>
    );
    expect(tone()).toBe('warn');
    await render(
      <SecretarySidebarSection view={{ ...view(), running: 1 }} folded={false} {...handlers}>
        {null}
      </SecretarySidebarSection>
    );
    expect(tone()).toBe('run');
    await render(
      <SecretarySidebarSection view={view()} folded={false} {...handlers}>
        {null}
      </SecretarySidebarSection>
    );
    expect(tone()).toBeNull();
  });

  it('折叠后隐藏会话行，仍保留人物卡与分隔', async () => {
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
  it('折叠侧栏时保留头像与状态点', async () => {
    const onClick = vi.fn();
    await render(
      <SecretaryCollapsedButton view={{ ...view(), name: '小安', needsYou: 2 }} onClick={onClick} />
    );
    const button = container.querySelector('[data-enso="secretary-collapsed"]');
    expect(button?.textContent).toContain('小');
    expect(container.querySelector('[data-enso="secretary-pip"]')?.getAttribute('data-tone')).toBe(
      'warn'
    );
    act(() => (button as unknown as HTMLElement).click());
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});
