import { parseHTML } from 'linkedom';
import { act, type ComponentProps, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TimelineItem } from '@/stores/sessions/timeline';
import { MessageTimeline } from './MessageTimeline';

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
vi.mock('react-virtuoso', () => ({ Virtuoso: () => null }));
vi.mock('./chatHost', () => ({ useChatHost: () => null }));
vi.mock('./NavRail', () => ({ NavRail: () => null }));
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
