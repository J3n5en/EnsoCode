import { parseHTML } from 'linkedom';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { headerSessionTabIds } from '@/stores/sessions/pinned';
import { publishSessionSwitch, useSessionSwitchState } from '@/stores/sessions/sessionSwitchState';
import { HeaderSessionTabs } from './HeaderSessionTabs';

type Conversation = Record<string, unknown> & { id: string; messages: { timestamp?: number }[] };

const harness = vi.hoisted(() => ({
  state: {
    conversations: {} as Record<string, unknown>,
    activeId: null as string | null,
    order: [] as string[],
    /** 侧栏算出的「活跃中」会话，顶栏标签的输入 */
    activeIds: [] as string[],
    selectConversation: (_id: string) => {},
  },
  secretary: {
    enabled: true,
    projectId: 'p-secretary',
    profile: null as Record<string, any> | null,
  },
}));

vi.mock('@/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock('@/stores/sessions', () => ({
  useSessionsStore: (select: (state: typeof harness.state) => unknown) => select(harness.state),
}));
vi.mock('@/stores/secretary', () => ({
  useSecretaryStore: (select: (state: { secretary: typeof harness.secretary }) => unknown) =>
    select({ secretary: harness.secretary }),
}));

const conversation = (id: string, over: Record<string, unknown> = {}): Conversation => ({
  id,
  title: `title-${id}`,
  projectId: 'p1',
  status: 'idle',
  createdAt: 1,
  messages: [],
  ...over,
});

const rect = (left: number, right: number): DOMRect =>
  ({
    left,
    right,
    top: 0,
    bottom: 28,
    width: right - left,
    height: 28,
    x: left,
    y: 0,
    toJSON: () => ({}),
  }) as DOMRect;

let root: Root;
let container: HTMLElement;
let scrolled: Element[];
let originalRect: (() => DOMRect) | undefined;
let originalScrollIntoView: (() => void) | undefined;

/** 模拟 Sidebar：按当前 conversations + dismissed 重算标签并发布（组件本身不订阅 dismissed） */
const publish = () => {
  const { state } = harness;
  const ids = headerSessionTabIds(
    state.activeIds,
    state.order,
    state.conversations as never,
    [],
    { now: Date.now(), ms: 0 },
    () => true,
    useSessionSwitchState.getState().dismissed
  );
  publishSessionSwitch(ids, ids.slice(0, 9));
};

const render = async () => {
  await act(async () => root.render(createElement(HeaderSessionTabs, { onNew: () => {} })));
};

const tabIds = () =>
  [...container.querySelectorAll('[data-session-tab]')].map((el) =>
    el.getAttribute('data-session-tab')
  );
const tab = (id: string) => container.querySelector(`[data-session-tab="${id}"]`);
const closeButton = (id: string) =>
  tab(id)?.querySelector('button[aria-label="Remove from title bar"]') as
    | HTMLButtonElement
    | null
    | undefined;
const click = async (el: Element | null | undefined) => {
  if (!el) throw new Error('missing clickable element');
  await act(async () => (el as HTMLElement).click());
};

beforeEach(async () => {
  const { window } = parseHTML('<html><body><div id="root"></div></body></html>');
  vi.stubGlobal('window', window);
  vi.stubGlobal('document', window.document);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('CSS', { escape: (value: string) => value });
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  );
  const proto = window.Element.prototype as unknown as Record<string, unknown>;
  originalRect = proto.getBoundingClientRect as () => DOMRect;
  originalScrollIntoView = proto.scrollIntoView as () => void;
  proto.getBoundingClientRect = function (this: Element) {
    if (this.getAttribute('data-enso') === 'main') return rect(20, 900);
    if (this.getAttribute('data-enso') === 'header-session-tabs') return rect(0, 1000);
    return rect(0, 0);
  };
  scrolled = [];
  proto.scrollIntoView = function (this: Element) {
    scrolled.push(this);
  };

  harness.state.conversations = {};
  harness.state.activeId = null;
  harness.state.order = [];
  harness.state.activeIds = [];
  harness.state.selectConversation = vi.fn();
  harness.secretary.enabled = true;
  harness.secretary.projectId = 'p-secretary';
  harness.secretary.profile = null;
  useSessionSwitchState.setState({
    modHeld: false,
    headerMounted: false,
    activeIds: [],
    slots: [],
    dismissed: {},
  });

  container = window.document.getElementById('root') as unknown as HTMLElement;
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  const proto = (
    globalThis.window as unknown as { Element: { prototype: Record<string, unknown> } }
  ).Element.prototype;
  proto.getBoundingClientRect = originalRect;
  proto.scrollIntoView = originalScrollIntoView;
  vi.unstubAllGlobals();
});

describe('HeaderSessionTabs 空状态', () => {
  it('没有标签时不渲染任何标签和新建按钮', async () => {
    await render();
    expect(container.querySelector('[data-enso="header-session-tabs"]')).not.toBeNull();
    expect(tabIds()).toEqual([]);
    expect(container.querySelector('button')).toBeNull();
  });
});

describe('HeaderSessionTabs 移出标签', () => {
  it('点移出后标签从顶栏消失，并记录到 dismissed', async () => {
    harness.state.conversations = { a: conversation('a'), b: conversation('b') };
    harness.state.activeIds = ['a', 'b'];
    harness.state.order = ['a', 'b'];
    harness.state.activeId = 'a';
    await render();
    await act(async () => publish());
    expect(tabIds()).toEqual(['a', 'b']);

    await click(closeButton('b'));

    expect(useSessionSwitchState.getState().dismissed.b).toEqual(expect.any(Number));
    await act(async () => publish());
    expect(tabIds()).toEqual(['a']);
  });

  it('移出的标签在会话有新消息后重新出现', async () => {
    harness.state.conversations = { a: conversation('a'), b: conversation('b') };
    harness.state.activeIds = ['a', 'b'];
    harness.state.order = ['a', 'b'];
    harness.state.activeId = 'a';
    await render();
    await act(async () => publish());
    await click(closeButton('b'));
    await act(async () => publish());
    expect(tabIds()).toEqual(['a']);

    // 新消息时间晚于移出时刻：headerSessionTabIds 重新收录
    harness.state.conversations = {
      a: conversation('a'),
      b: conversation('b', { messages: [{ timestamp: Date.now() + 1000 }] }),
    };
    await act(async () => publish());
    expect(tabIds()).toEqual(['a', 'b']);
  });

  it('只剩一个标签时不可移出', async () => {
    harness.state.conversations = { a: conversation('a') };
    harness.state.activeIds = ['a'];
    harness.state.order = ['a'];
    harness.state.activeId = 'a';
    await render();
    await act(async () => publish());
    expect(tabIds()).toEqual(['a']);
    expect(closeButton('a')).toBeNull();
  });

  it('移出当前会话时先切到相邻标签', async () => {
    harness.state.conversations = { a: conversation('a'), b: conversation('b') };
    harness.state.activeIds = ['a', 'b'];
    harness.state.order = ['a', 'b'];
    harness.state.activeId = 'a';
    await render();
    await act(async () => publish());

    await click(closeButton('a'));

    expect(harness.state.selectConversation).toHaveBeenCalledWith('b');
    expect(useSessionSwitchState.getState().dismissed.a).toEqual(expect.any(Number));
  });
});

describe('HeaderSessionTabs 秘书头像', () => {
  it('秘书会话显示秘书头像，普通会话显示状态点', async () => {
    harness.secretary.profile = { name: '小秘', avatar: { color: '#123456' } };
    harness.state.conversations = {
      sec: conversation('sec', { projectId: 'p-secretary' }),
      run: conversation('run', { status: 'running' }),
    };
    harness.state.activeIds = ['sec', 'run'];
    harness.state.order = ['sec', 'run'];
    harness.state.activeId = 'sec';
    await render();
    await act(async () => publish());

    const sec = tab('sec');
    expect(sec?.querySelector('[data-enso="secretary-tab-avatar"]')).not.toBeNull();
    expect(sec?.querySelector('[data-slot="conversation-status"]')).toBeNull();

    const run = tab('run');
    expect(run?.querySelector('[data-slot="conversation-status"]')?.getAttribute('data-tone')).toBe(
      'running'
    );
    expect(run?.querySelector('[data-enso="secretary-tab-avatar"]')).toBeNull();
  });

  it('秘书头像有图时用图片，无图时按名字生成 boring-avatars', async () => {
    harness.secretary.profile = { name: '小秘', avatar: { color: '#123456', imageVersion: 3 } };
    harness.state.conversations = { sec: conversation('sec', { projectId: 'p-secretary' }) };
    harness.state.activeIds = ['sec'];
    harness.state.order = ['sec'];
    harness.state.activeId = 'sec';
    await render();
    await act(async () => publish());
    const avatar = tab('sec')?.querySelector('[data-enso="secretary-tab-avatar"]');
    expect(avatar?.tagName).toBe('IMG');
    expect(avatar?.getAttribute('src')).toContain('avatar.png?v=3');

    harness.secretary.profile = { name: '小秘', avatar: { color: '#123456' } };
    await render();
    const initial = tab('sec')?.querySelector('[data-enso="secretary-tab-avatar"]');
    expect(initial?.tagName).toBe('SPAN');
    expect(initial?.getAttribute('data-generated')).toBe('true');
    expect(initial?.querySelector('svg')).not.toBeNull();
  });

  it('秘书标签和普通标签共存，秘书标签移出后再出现头像仍在', async () => {
    harness.secretary.profile = { name: '小秘', avatar: { color: '#123456' } };
    harness.state.conversations = {
      sec: conversation('sec', { projectId: 'p-secretary' }),
      plain: conversation('plain'),
    };
    harness.state.activeIds = ['sec', 'plain'];
    harness.state.order = ['sec', 'plain'];
    harness.state.activeId = 'plain';
    await render();
    await act(async () => publish());
    expect(tabIds()).toEqual(['sec', 'plain']);

    await click(closeButton('sec'));
    await act(async () => publish());
    expect(tabIds()).toEqual(['plain']);

    harness.state.conversations = {
      sec: conversation('sec', {
        projectId: 'p-secretary',
        messages: [{ timestamp: Date.now() + 1000 }],
      }),
      plain: conversation('plain'),
    };
    await act(async () => publish());
    expect(tabIds()).toEqual(['sec', 'plain']);
    expect(tab('sec')?.querySelector('[data-enso="secretary-tab-avatar"]')).not.toBeNull();
  });
});

describe('HeaderSessionTabs 布局', () => {
  it('标签横向滚动不换行，标签定宽可压缩', async () => {
    harness.state.conversations = { a: conversation('a'), b: conversation('b') };
    harness.state.activeIds = ['a', 'b'];
    harness.state.order = ['a', 'b'];
    harness.state.activeId = 'a';
    await render();
    await act(async () => publish());

    const tab = container.querySelector('[data-session-tab="a"]');
    const strip = tab?.parentElement;
    expect(strip?.className).toContain('overflow-x-auto');
    expect(strip?.className).toContain('min-w-0');
    expect(tab?.className).toContain('w-[202.5px]');
    expect(tab?.className).toContain('min-w-[80px]');
    expect(tab?.className).toContain('shrink');
  });

  it('左右内边距跟随主卡片，激活标签滚动到可见区', async () => {
    const main = container.ownerDocument.createElement('div');
    main.setAttribute('data-enso', 'main');
    container.ownerDocument.body.appendChild(main);
    harness.state.conversations = { a: conversation('a'), b: conversation('b') };
    harness.state.activeIds = ['a', 'b'];
    harness.state.order = ['a', 'b'];
    harness.state.activeId = 'b';
    // 标签在挂载前已发布：挂载时激活标签的滚动定位才会命中元素
    publish();
    await render();

    const rootEl = container.querySelector('[data-enso="header-session-tabs"]') as HTMLElement;
    expect(rootEl.style.paddingLeft).toBe('20px');
    expect(rootEl.style.paddingRight).toBe('100px');
    expect(scrolled).toContain(tab('b'));
  });
});
