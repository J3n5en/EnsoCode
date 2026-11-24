import { parseHTML } from 'linkedom';
import { act, type ComponentProps, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setLayoutAnimating } from '@/stores/layoutAnimation';
import type { TimelineItem } from '@/stores/sessions/timeline';
import { MessageTimeline } from './MessageTimeline';
import type { NavRailItem } from './NavRail';

let navItems: NavRailItem[] = [];
let virtuosoProps: {
  atBottomStateChange: (value: boolean) => void;
  followOutput: (isAtBottom: boolean) => unknown;
  scrollerRef: (el: unknown) => void;
} | null = null;

vi.mock('@/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock('@/stores/settings', () => ({ useSettingsStore: () => false }));
vi.mock('@/stores/sessions/timeline', () => ({
  historyPageChrome: () => 'none',
  shouldPrefetchOlderHistory: () => false,
}));
vi.mock('@/components/secretary/useSecretaryFace', () => ({ useSecretaryFace: () => null }));
vi.mock('@/components/secretary/SecretaryAvatar', () => ({ SecretaryAvatar: () => null }));
vi.mock('@/components/ui/button', () => ({
  Button: (props: ComponentProps<'button'>) =>
    createElement('button', { type: 'button', ...props }),
}));
vi.mock('react-virtuoso', () => ({
  Virtuoso: (props: NonNullable<typeof virtuosoProps>) => {
    virtuosoProps = props;
    return null;
  },
}));
vi.mock('./chatHost', () => ({ useChatHost: () => null }));
vi.mock('./NavRail', () => ({
  NavRail: (props: { items: NavRailItem[] }) => {
    navItems = props.items;
    return null;
  },
}));
vi.mock('./WelcomeSuggestions', () => ({ WelcomeSuggestions: () => null }));
vi.mock('./useFoldedTimeline', () => ({ useFoldedTimeline: (items: unknown) => items }));
vi.mock('./TimelineRow', () => ({
  TimelineRow: () => createElement('p', null, 'row'),
  ReplyHeader: () => null,
  RetryTurnButton: () => null,
  isCompactRow: () => false,
  isToolStepRow: () => false,
}));

const items = [{ kind: 'user', key: 'u1', text: 'hi' }] as unknown as TimelineItem[];
let root: Root;
let container: HTMLElement;
let resize: () => void;
let scroller: HTMLElement;
const geometry = { scrollHeight: 2000, clientHeight: 500 };

const fire = (el: Element, type: string, bubbles = true) =>
  act(async () => {
    el.dispatchEvent(new window.Event(type, { bubbles }));
  });
const bottomButton = () =>
  [...container.querySelectorAll('button')].find((el) => el.textContent === 'Scroll to bottom');

/** 手指在消息区上滑：离开底部，出现「回到底部」，抬手 400ms 后滚动意图结束 */
async function swipeUp() {
  await fire(scroller, 'touchstart');
  scroller.scrollTop = 0;
  await fire(scroller, 'scroll', false);
  await fire(scroller, 'touchend');
  await act(async () => vi.advanceTimersByTime(500));
}

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const { window } = parseHTML('<html><body><div id="root"></div></body></html>');
  vi.stubGlobal('window', window);
  vi.stubGlobal('document', window.document);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  // 纠正循环只跑首帧，足以观察是否写了 scrollTop
  vi.stubGlobal('requestAnimationFrame', () => 0);
  vi.stubGlobal('cancelAnimationFrame', () => {});
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(callback: () => void) {
        resize = callback;
      }
      observe() {}
      disconnect() {}
    }
  );
  geometry.scrollHeight = 2000;
  container = window.document.getElementById('root') as unknown as HTMLElement;
  root = createRoot(container);
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
  Object.defineProperties(scroller, {
    scrollHeight: { get: () => geometry.scrollHeight },
    clientHeight: { get: () => geometry.clientHeight },
    scrollTop: {
      get: () => top,
      set: (value: number) => {
        top = Math.min(value, geometry.scrollHeight - geometry.clientHeight);
      },
    },
  });
});
afterEach(async () => {
  await act(async () => root.unmount());
  setLayoutAnimating(false);
  virtuosoProps = null;
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('MessageTimeline 回到底部（全量渲染）', () => {
  it('用户上滑后出现回到底部按钮', async () => {
    await swipeUp();
    expect(bottomButton()).toBeDefined();
  });

  // 真机：触屏点按钮的 touchstart 冒泡到时间线根节点，曾被当成用户滚动，纠正循环首帧即中止
  it('触屏点一次即滚到底，之后新内容继续跟随', async () => {
    await swipeUp();
    const button = bottomButton();
    if (!button) throw new Error('Missing scroll-to-bottom button');
    await fire(button, 'touchstart');
    await fire(button, 'touchend');
    await act(async () => button.click());
    expect(scroller.scrollTop).toBe(1500);
    await fire(scroller, 'scroll', false);
    expect(bottomButton()).toBeUndefined();

    geometry.scrollHeight = 2600;
    await act(async () => resize());
    expect(scroller.scrollTop).toBe(2100);
  });

  it('鼠标点击按钮同样滚到底', async () => {
    await swipeUp();
    const button = bottomButton();
    if (!button) throw new Error('Missing scroll-to-bottom button');
    await fire(button, 'pointerdown');
    await act(async () => button.click());
    expect(scroller.scrollTop).toBe(1500);
  });

  it('跟随中手指上滑即停止跟随', async () => {
    await swipeUp();
    geometry.scrollHeight = 2600;
    await act(async () => resize());
    expect(scroller.scrollTop).toBe(0);
    expect(bottomButton()).toBeDefined();
  });
});

describe('MessageTimeline 导航条', () => {
  it('轮次预览不露引用块标签，显示追问本身', async () => {
    const quoted = [
      { kind: 'user', key: 'u1', text: '<quote>\n引用的原文\n</quote>\n为什么这样？' },
      { kind: 'user', key: 'u2', text: '<quote>\n只有引用\n</quote>' },
    ] as unknown as TimelineItem[];
    await act(async () =>
      root.render(
        createElement(MessageTimeline, {
          items: quoted,
          busy: false,
          running: false,
          emptyTitle: 'Project',
          virtualize: false,
        })
      )
    );
    expect(navItems.map((item) => item.question)).toEqual(['为什么这样？', '只有引用']);
  });
});

describe('MessageTimeline 右侧面板宽度动画（虚拟化）', () => {
  let writes: number;
  let vScroller: HTMLElement;

  const virtuoso = () => {
    if (!virtuosoProps) throw new Error('Virtuoso not rendered');
    return virtuosoProps;
  };
  /** Virtuoso 报告离底：宽度变窄后内容换行变高，scrollTop 没动，底部被挤出视口 */
  const reportLeftBottom = () => act(async () => virtuoso().atBottomStateChange(false));

  beforeEach(async () => {
    await act(async () =>
      root.render(
        createElement(MessageTimeline, {
          items,
          busy: true,
          running: true,
          emptyTitle: 'Project',
        })
      )
    );
    writes = 0;
    let top = 1500;
    vi.stubGlobal('HTMLElement', window.HTMLElement);
    vScroller = window.document.createElement('div') as unknown as HTMLElement;
    Object.defineProperties(vScroller, {
      scrollHeight: { get: () => 2400 },
      clientHeight: { get: () => 500 },
      scrollTop: {
        get: () => top,
        set: (value: number) => {
          writes += 1;
          top = Math.min(value, 1900);
        },
      },
    });
    await act(async () => virtuoso().scrollerRef(vScroller));
  });

  it('动画期间离底不触发贴底纠正，也不解除贴底判定', async () => {
    setLayoutAnimating(true);
    await reportLeftBottom();
    expect(writes).toBe(0);
    expect(bottomButton()).toBeUndefined();
    expect(virtuoso().followOutput(true)).toBe(false);
  });

  it('动画结束后按跟随语义单次贴底，之后离底恢复原有纠正', async () => {
    setLayoutAnimating(true);
    await reportLeftBottom();
    expect(writes).toBe(0);
    await act(async () => setLayoutAnimating(false));
    expect(writes).toBe(1);
    expect(vScroller.scrollTop).toBe(1900);
    expect(virtuoso().followOutput(true)).toBe('auto');

    vScroller.scrollTop = 1500;
    writes = 0;
    await reportLeftBottom();
    expect(writes).toBe(1);
    expect(bottomButton()).toBeUndefined();
  });

  it('动画中没有离底就不补滚动', async () => {
    setLayoutAnimating(true);
    await act(async () => setLayoutAnimating(false));
    expect(writes).toBe(0);
  });

  it('未动画时离底照旧贴底纠正', async () => {
    await reportLeftBottom();
    expect(writes).toBe(1);
  });

  it('用户上滚时即使在动画中也不被拉回底部', async () => {
    setLayoutAnimating(true);
    await fire(container.firstElementChild as Element, 'wheel');
    await reportLeftBottom();
    expect(writes).toBe(0);
    expect(bottomButton()).toBeDefined();

    await act(async () => setLayoutAnimating(false));
    expect(writes).toBe(0);
    expect(bottomButton()).toBeDefined();
  });

  it('用户上滚时（无动画）同样不被拉回底部', async () => {
    await fire(container.firstElementChild as Element, 'wheel');
    await reportLeftBottom();
    expect(writes).toBe(0);
    expect(bottomButton()).toBeDefined();
  });
});
