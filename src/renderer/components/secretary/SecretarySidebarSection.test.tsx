import { REMOTE_LOCAL_IMAGE_PREFIX_KEY } from '@shared/localImage';
import type { SecretaryState } from '@shared/types/secretary';
import { parseHTML } from 'linkedom';
import { act, type ReactElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const getSessions = vi.hoisted(() => vi.fn());

vi.mock('@/stores/sessions', () => ({ useSessionsStore: { getState: getSessions } }));
vi.mock('@/stores/settings', () => ({
  useSettingsStore: {
    getState: () => ({ projects: [{ id: 'sec', path: '/tmp/secretary' }] }),
  },
}));
vi.mock('@/stores/modelDirectory/useProviders', () => ({ readMaterializedProviders: () => [] }));
vi.mock('@/stores/oauthCredentials', () => ({
  useOauthCredentialStore: { getState: () => ({ snapshot: {} }) },
  oauthCredentialContext: () => ({}),
}));
vi.mock('@/stores/sidePanel', () => ({ useSidePanelStore: { getState: () => ({}) } }));

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
vi.mock('@/components/ui/preview-card', () => ({
  PreviewCard: ({ children }: { children: ReactNode }) => <>{children}</>,
  PreviewCardTrigger: ({ children }: { children: ReactNode }) => <span>{children}</span>,
  PreviewCardPopup: ({ children }: { children: ReactNode }) => (
    <div data-enso="popup">{children}</div>
  ),
}));

import { openSecretary } from '@/lib/openSecretary';
import { EMPTY_SECRETARY_STATE, useSecretaryStore } from '@/stores/secretary';
import { runningBySecretary, SecretaryDispatchBadge } from './SecretaryRunningOrigins';
import {
  SecretaryCollapsedButton,
  SecretaryGroupHeader,
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
  takeoverScope: { mode: 'projects', projectIds: [] },
  visibleProjectIds: 'all',
  maxRunningDispatches: 3,
  patrolEnabled: true,
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
  useSecretaryStore.setState(useSecretaryStore.getInitialState(), true);
  getSessions.mockReset();
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

  it('图片地址带上这份状态所属的秘书 id；显式传入的 id 优先', () => {
    const owned = state({
      secretaryId: 's-248c5247',
      profile: { ...profile, avatar: { color: '#ff00aa', imageVersion: 2 } },
    });
    expect(secretarySectionView(owned, t)?.image).toBe(
      'local-image://secretary-avatar/avatar.png?v=2&s=s-248c5247'
    );
    expect(secretarySectionView(owned, t, 'other')?.image).toBe(
      'local-image://secretary-avatar/avatar.png?v=2&s=other'
    );
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

  it.each([
    { scenario: '未设置', configured: false, hasConversation: false },
    { scenario: '已设置但没有会话', configured: true, hasConversation: false },
    { scenario: '已有秘书会话', configured: true, hasConversation: true },
  ])(
    '$scenario 时，点人物卡会保留入口并打开正确的页面',
    async ({ configured, hasConversation }) => {
      const secretary = state({ secretaryId: 'default', profile: configured ? profile : null });
      useSecretaryStore.setState({
        secretary,
        secretaries: [
          {
            id: 'default',
            projectId: 'sec',
            name: secretary.profile?.name ?? null,
            avatar: null,
            order: 0,
          },
        ],
        states: { default: secretary },
        focusedId: 'default',
        welcomeOpen: false,
      });
      const selectConversation = vi.fn();
      const newConversation = vi.fn(async (_projectId: string) => 'new-secretary-conversation');
      getSessions.mockReturnValue({
        order: hasConversation ? ['existing'] : [],
        conversations: hasConversation ? { existing: { projectId: 'sec', lastActiveAt: 1 } } : {},
        selectConversation,
        newConversation,
      });
      vi.stubGlobal('electronAPI', {
        secretary: { getState: vi.fn().mockResolvedValue(EMPTY_SECRETARY_STATE) },
      });

      const handlers = actions();
      function SingleSecretaryEntry() {
        const current = useSecretaryStore((store) => store.secretary);
        const entry = secretarySectionView(current, t);
        return entry ? (
          <SecretarySidebarSection view={entry} folded={false} {...handlers} onOpen={openSecretary}>
            {null}
          </SecretarySidebarSection>
        ) : null;
      }

      await render(<SingleSecretaryEntry />);
      await act(async () => click('[data-enso="secretary-open"]'));

      expect(container.querySelector('[data-enso="secretary-open"]')).not.toBeNull();
      expect(useSecretaryStore.getState().focusedId).toBe('default');
      expect(useSecretaryStore.getState().welcomeOpen).toBe(!configured);
      expect(selectConversation.mock.calls).toEqual(hasConversation ? [['existing']] : []);
      expect(newConversation.mock.calls).toEqual(configured && !hasConversation ? [['sec']] : []);
    }
  );

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
    expect(handlers.onOpen.mock.calls[0]).toHaveLength(0);
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

  it('只有一个秘书时，折叠后箭头顶掉头像', async () => {
    await render(
      <SecretarySidebarSection view={view()} folded {...actions()}>
        {null}
      </SecretarySidebarSection>
    );
    const avatar = container.querySelector('[data-enso="secretary-avatar"]');
    expect(avatar?.parentElement?.className).toContain('hidden');
    const icon = container.querySelector('[data-enso="secretary-fold-icon"]');
    expect(icon?.className).toContain('flex');
    expect(icon?.className).not.toContain('absolute');
  });

  it('多个秘书折叠后头像仍在，箭头叠在头像上、平时不显示', async () => {
    await render(
      <SecretarySidebarSection view={view()} folded keepAvatar {...actions()}>
        {null}
      </SecretarySidebarSection>
    );
    const avatar = container.querySelector('[data-enso="secretary-avatar"]');
    expect(avatar).not.toBeNull();
    expect(avatar?.parentElement?.className ?? '').not.toContain('hidden');
    const icon = container.querySelector('[data-enso="secretary-fold-icon"]');
    expect(icon?.className).toContain('absolute');
    expect(icon?.className).toContain('inset-0');
    expect(icon?.className).toContain('hidden');
    expect(icon?.className).toContain('group-hover:flex');
    expect(icon?.className).toContain('group-has-[:focus-visible]:flex');
    expect(icon?.querySelector('svg')?.getAttribute('class')).toContain('-rotate-90');
  });

  it('多个秘书展开时箭头同样只在悬停或键盘聚焦时出现', async () => {
    await render(
      <SecretarySidebarSection view={view()} folded={false} keepAvatar {...actions()}>
        {null}
      </SecretarySidebarSection>
    );
    const icon = container.querySelector('[data-enso="secretary-fold-icon"]');
    expect(icon?.className).toContain('hidden');
    expect(icon?.className).toContain('group-hover:flex');
    expect(icon?.className).not.toContain('group-hover:hidden');
    expect(container.querySelector('[data-enso="secretary-avatar"]')).not.toBeNull();
  });

  it('触屏上箭头不叠在头像上：头像始终露出，行尾另给折叠按钮', async () => {
    for (const keepAvatar of [true, false]) {
      for (const folded of [true, false]) {
        const handlers = actions();
        await render(
          <SecretarySidebarSection
            view={view()}
            folded={folded}
            keepAvatar={keepAvatar}
            {...handlers}
          >
            {null}
          </SecretarySidebarSection>
        );
        const icon = container.querySelector('[data-enso="secretary-fold-icon"]');
        expect(icon?.className).toContain('[@media(hover:none)]:hidden!');
        expect(icon?.className).not.toContain('[@media(hover:none)]:flex');
        const avatarBox = container.querySelector('[data-enso="secretary-avatar"]')?.parentElement;
        if (avatarBox?.className.split(' ').includes('hidden')) {
          expect(avatarBox.className).toContain('[@media(hover:none)]:block');
        }
        const trailing = container.querySelector<HTMLElement>(
          '[data-enso="secretary-fold-trailing"]'
        );
        expect(trailing?.className.split(' ')).toContain('hidden');
        expect(trailing?.className).toContain('[@media(hover:none)]:flex');
        expect(trailing?.getAttribute('aria-expanded')).toBe(String(!folded));
        expect(trailing?.querySelector('svg')?.getAttribute('class')?.includes('-rotate-90')).toBe(
          folded
        );
        act(() => trailing?.click());
        expect(handlers.onToggleFold).toHaveBeenCalledTimes(1);
      }
    }
  });

  it('配对页面里头像走隧道地址，不带本机路径；加载失败退回生成头像', async () => {
    (globalThis as Record<string, unknown>)[REMOTE_LOCAL_IMAGE_PREFIX_KEY] = '/desk/li/pair/';
    try {
      const remote = view({
        secretaryId: 's-ken',
        profile: { ...profile, avatar: { color: '#ff00aa', imageVersion: 3, imageHash: 'abcd' } },
      });
      await render(
        <SecretarySidebarSection view={remote} folded keepAvatar {...actions()}>
          {null}
        </SecretarySidebarSection>
      );
      const img = container.querySelector('img[data-enso="secretary-avatar-face"]');
      const src = img?.getAttribute('src') ?? '';
      expect(src.startsWith('/desk/li/pair/')).toBe(true);
      expect(decodeURIComponent(src)).toBe(
        '/desk/li/pair/local-image://secretary-avatar/avatar.png?v=3&h=abcd&s=s-ken'
      );
      await act(async () => {
        img?.dispatchEvent(new window.Event('error'));
      });
      const face = container.querySelector('[data-enso="secretary-avatar-face"]');
      expect(face?.tagName).toBe('SPAN');
      expect(face?.getAttribute('data-generated')).toBe('true');
      expect(face?.querySelector('svg')).not.toBeNull();
    } finally {
      delete (globalThis as Record<string, unknown>)[REMOTE_LOCAL_IMAGE_PREFIX_KEY];
    }
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

  it('两个秘书各派一件：计数与悬停列表只落在各自的分区和会话行', async () => {
    const secretaries = [
      {
        id: 'a',
        conversations: ['sa', 'sa2'],
        board: [{ ...sessionCard('ca'), secretaryConversationId: 'sa' }],
      },
      {
        id: 'b',
        conversations: ['sb'],
        board: [{ ...sessionCard('cb'), secretaryConversationId: 'sb' }],
      },
    ];
    const states = Object.fromEntries(
      secretaries.map((entry) => [
        entry.id,
        state({ profile, board: { needsYou: [], running: entry.board, done: [], todos: [] } }),
      ])
    );
    const running = runningBySecretary(secretaries, states, () => true);
    await render(
      <div>
        {secretaries.map((entry) => {
          const origins = running[entry.id];
          return (
            <SecretarySidebarSection
              key={entry.id}
              view={view({ profile, board: states[entry.id]?.board })}
              folded={false}
              secretaryId={entry.id}
              runningOrigins={
                origins && { groups: origins.groups, titleOf: (id) => id, onSelect: vi.fn() }
              }
              {...actions()}
            >
              {entry.conversations.map((id) => (
                <div key={id} data-row={id}>
                  <SecretaryDispatchBadge count={origins?.counts[id]} />
                </div>
              ))}
            </SecretarySidebarSection>
          );
        })}
      </div>
    );
    const section = (id: string) =>
      container.querySelector(`[data-enso="secretary-section"][data-secretary-id="${id}"]`);
    const badge = (id: string) =>
      container.querySelector(`[data-row="${id}"] [data-enso="secretary-dispatch-running"]`)
        ?.textContent ?? null;
    const origins = (id: string) =>
      [...(section(id)?.querySelectorAll('[data-enso="secretary-running-origin"]') ?? [])].map(
        (node) => node.textContent
      );
    expect([badge('sa'), badge('sa2'), badge('sb')]).toEqual(['1', null, '1']);
    expect(section('a')?.querySelector('[data-row="sb"]')).toBeNull();
    expect(origins('a')).toEqual(['sa1跑测试']);
    expect(origins('b')).toEqual(['sb1跑测试']);
  });
});

describe('SecretaryGroupHeader', () => {
  it('整块标题的箭头常显，样式与临时会话分组一致，折叠只旋转不挪字', async () => {
    const onToggleFold = vi.fn();
    await render(
      <SecretaryGroupHeader
        count={2}
        folded
        needsYou={0}
        onToggleFold={onToggleFold}
        onCreate={vi.fn()}
      />
    );
    const chevron = container.querySelector('[data-enso="secretary-group-chevron"]');
    const cls = chevron?.getAttribute('class') ?? '';
    expect(cls).not.toContain('opacity-0');
    expect(cls).toContain('opacity-100');
    expect(cls).toContain('text-subtle-foreground');
    expect(cls).toContain('-rotate-90');
    expect(cls).toContain('shrink-0');
    act(() =>
      (container.querySelector('[data-enso="secretary-group-fold"]') as HTMLElement).click()
    );
    expect(onToggleFold).toHaveBeenCalledTimes(1);
  });

  it('展开时箭头仍可见，悬停加深', async () => {
    await render(
      <SecretaryGroupHeader
        count={2}
        folded={false}
        needsYou={0}
        onToggleFold={vi.fn()}
        onCreate={vi.fn()}
      />
    );
    const cls =
      container.querySelector('[data-enso="secretary-group-chevron"]')?.getAttribute('class') ?? '';
    expect(cls).not.toContain('opacity-0');
    expect(cls).toContain('opacity-70');
    expect(cls).toContain('group-hover:opacity-100');
    expect(cls).not.toContain('-rotate-90');
  });
});

describe('SecretaryCollapsedButton', () => {
  it('折叠侧栏时保留头像与状态点', async () => {
    const onClick = vi.fn();
    await render(
      <SecretaryCollapsedButton view={{ ...view(), name: '小安', needsYou: 2 }} onClick={onClick} />
    );
    const button = container.querySelector('[data-enso="secretary-collapsed"]');
    expect(button?.querySelector('[data-generated="true"] svg')).not.toBeNull();
    expect(container.querySelector('[data-enso="secretary-pip"]')?.getAttribute('data-tone')).toBe(
      'warn'
    );
    act(() => (button as unknown as HTMLElement).click());
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});
