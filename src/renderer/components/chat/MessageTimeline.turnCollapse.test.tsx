import { parseHTML } from 'linkedom';
import { act, type ComponentProps, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { acquireOverlayGuard, resetOverlayGuard, setOverlayGuardSink } from '@/lib/overlayGuard';
import type { TimelineItem } from '@/stores/sessions/timeline';
import { MessageTimeline } from './MessageTimeline';

const settings = { autoCollapseTurns: true };

vi.mock('@/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock('@/stores/settings', () => ({
  useSettingsStore: (select: (state: object) => unknown) => select(settings),
}));
vi.mock('@/stores/sessions', () => ({ useSessionsStore: () => null }));
vi.mock('@/components/secretary/useSecretaryFace', () => ({ useSecretaryFace: () => null }));
vi.mock('@/components/secretary/SecretaryAvatar', () => ({ SecretaryAvatar: () => null }));
vi.mock('@/components/ui/button', () => ({
  Button: (props: ComponentProps<'button'>) =>
    createElement('button', { type: 'button', ...props }),
}));
vi.mock('react-virtuoso', () => ({ Virtuoso: () => null }));
vi.mock('./chatHost', () => ({ useChatHost: () => null }));
vi.mock('./NavRail', () => ({ NavRail: () => null }));
vi.mock('./WelcomeSuggestions', () => ({ WelcomeSuggestions: () => null }));
// 只模拟整轮折叠：被收起轮次的回复行隐藏，用户行带 collapsed
vi.mock('./useFoldedTimeline', () => ({
  useFoldedTimeline: (
    rows: TimelineItem[],
    _running: boolean,
    _groups: unknown,
    options: { turnOverrides: ReadonlyMap<string, boolean> }
  ) => {
    const out: TimelineItem[] = [];
    let hidden = false;
    for (const row of rows) {
      if (row.kind === 'user') {
        hidden = options.turnOverrides.get(row.key) === true;
        out.push(hidden ? { ...row, collapsed: true } : row);
      } else if (!hidden) out.push(row);
    }
    return out;
  },
}));
vi.mock('./TimelineRow', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./TimelineRow')>()),
  ReplyHeader: () => null,
  TimelineRow: ({ item }: { item: TimelineItem }) =>
    item.kind === 'text' ? createElement('textarea') : createElement('p', null, item.key),
}));

const items = [
  { kind: 'user', key: '0', text: 'q1', images: [], canCollapse: true },
  { kind: 'text', key: '1-0', text: 'a1', streaming: false },
  { kind: 'user', key: '2', text: 'q2', images: [], canCollapse: false },
  { kind: 'text', key: '3-0', text: 'a2', streaming: false },
] as unknown as TimelineItem[];

/** 视口 0..600：第一轮用户行已滚出上方，回复跨进视口；第二轮完整可见 */
const RECTS: Record<string, [number, number]> = {
  '0': [-900, -800],
  '1-0': [-800, 300],
  '2': [300, 400],
  '3-0': [400, 500],
};

let root: Root;
let container: HTMLElement;
let scroller: HTMLElement;

beforeEach(() => {
  const { window } = parseHTML('<html><body><div id="root"></div></body></html>');
  vi.stubGlobal('window', window);
  vi.stubGlobal('document', window.document);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('requestAnimationFrame', () => 0);
  vi.stubGlobal('cancelAnimationFrame', () => {});
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
    }
  );
  settings.autoCollapseTurns = true;
  // linkedom 的 window 首次 addEventListener 前不在事件路径里；真机 App 常驻窗口级 keydown 监听
  window.addEventListener('keydown', () => {});
  container = window.document.getElementById('root') as unknown as HTMLElement;
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  vi.unstubAllGlobals();
});

async function mount() {
  await act(async () =>
    root.render(
      createElement(MessageTimeline, {
        items,
        busy: false,
        running: false,
        emptyTitle: 'Project',
        virtualize: false,
      })
    )
  );
  const el = container.querySelector('.overflow-y-auto');
  if (!el) throw new Error('Missing scroller');
  scroller = el as HTMLElement;
  let top = 1500;
  Object.defineProperty(scroller, 'scrollTop', {
    configurable: true,
    get: () => top,
    set: (value: number) => {
      top = value;
    },
  });
  Object.defineProperty(scroller, 'getBoundingClientRect', {
    value: () => ({ top: 0, bottom: 600, left: 0, right: 390, width: 390, height: 600 }),
  });
  for (const row of container.querySelectorAll('[data-nav-key]')) {
    const [rowTop, rowBottom] = RECTS[row.getAttribute('data-nav-key') ?? ''];
    Object.defineProperty(row, 'getBoundingClientRect', {
      value: () => ({ top: rowTop, bottom: rowBottom, left: 0, right: 390 }),
    });
  }
}

const footers = () => [...container.querySelectorAll('[data-enso="turn-collapse"]')];
const collapsed = () => !container.querySelector('[data-nav-key="1-0"]');

async function pressEscape(target: Element): Promise<boolean> {
  const event = new window.Event('keydown', { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'key', { value: 'Escape' });
  await act(async () => {
    target.dispatchEvent(event);
  });
  return event.defaultPrevented;
}

describe('MessageTimeline 轮次末尾收起', () => {
  it('只在已展开且可折叠的轮次末尾出现；点击后收起并把视口拉回该轮顶部', async () => {
    await mount();
    expect(footers()).toHaveLength(1);
    expect(container.querySelector('[data-nav-key="1-0"] [data-enso="turn-collapse"]')).not.toBe(
      null
    );
    await act(async () => (footers()[0] as HTMLButtonElement).click());
    expect(collapsed()).toBe(true);
    expect(footers()).toHaveLength(0);
    // 用户行顶在视口上方 900px：-900 - 0 - 16 = -916
    expect(scroller.scrollTop).toBe(584);
  });

  it('关闭自动折叠时没有底部收起，Esc 也不拦截', async () => {
    settings.autoCollapseTurns = false;
    await mount();
    expect(footers()).toHaveLength(0);
    expect(await pressEscape(scroller)).toBe(false);
    expect(collapsed()).toBe(false);
  });
});

describe('MessageTimeline Esc 收起当前轮', () => {
  it('收起视口内第一个可折叠的展开轮次；没有可收的轮次时不 preventDefault', async () => {
    await mount();
    expect(await pressEscape(scroller)).toBe(true);
    expect(collapsed()).toBe(true);
    expect(scroller.scrollTop).toBe(584);
    // 剩下的第二轮不可折叠
    expect(await pressEscape(scroller)).toBe(false);
  });

  it('焦点在输入框里时交给输入框处理', async () => {
    await mount();
    const textarea = container.querySelector('textarea');
    if (!textarea) throw new Error('Missing textarea');
    // linkedom 下 React 走旧版 input 事件 polyfill：需先 focusin 且元素带 attachEvent
    Object.assign(textarea, { attachEvent() {}, detachEvent() {} });
    await act(async () => {
      textarea.dispatchEvent(new window.Event('focusin', { bubbles: true }));
    });
    expect(await pressEscape(textarea)).toBe(false);
    expect(collapsed()).toBe(false);
  });

  it('有打开的对话框时不响应', async () => {
    await mount();
    const dialog = document.createElement('div');
    dialog.setAttribute('role', 'dialog');
    document.body.appendChild(dialog);
    expect(await pressEscape(scroller)).toBe(false);
    expect(collapsed()).toBe(false);
  });

  // 真实场景：点开消息里的图片预览或 Mermaid 全屏，按 Esc 只该关预览，不该顺带收起整轮
  it('图片预览、Mermaid 全屏等模态浮层打开时不响应', async () => {
    await mount();
    setOverlayGuardSink(() => {});
    acquireOverlayGuard();
    try {
      expect(await pressEscape(scroller)).toBe(false);
      expect(collapsed()).toBe(false);
    } finally {
      resetOverlayGuard();
    }
  });

  // 真实场景：会话内搜索开着、焦点在消息区，按 Esc 只该关搜索条（窗口级监听）
  it('窗口级 Esc 处理（会话内搜索、侧栏全屏）已认领时不收起', async () => {
    await mount();
    const claim = (event: Event) => event.preventDefault();
    window.addEventListener('keydown', claim);
    try {
      expect(await pressEscape(scroller)).toBe(true);
      expect(collapsed()).toBe(false);
    } finally {
      window.removeEventListener('keydown', claim);
    }
  });
});
