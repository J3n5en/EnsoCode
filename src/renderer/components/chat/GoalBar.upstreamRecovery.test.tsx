import { parseHTML } from 'linkedom';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const retryUpstreamNow = vi.fn(async () => {});
const abort = vi.fn(async () => {});
const pauseGoal = vi.fn();
const resumeGoal = vi.fn();
const clearGoal = vi.fn();

vi.mock('@/i18n', () => ({
  useI18n: () => ({
    t: (key: string, params?: Record<string, string | number>) =>
      params ? key.replace(/\{\{(\w+)\}\}/g, (_, k: string) => String(params[k] ?? '')) : key,
  }),
}));

vi.mock('@/stores/sessions', () => ({
  useSessionsStore: {
    getState: () => ({
      retryUpstreamNow,
      abort,
      pauseGoal,
      resumeGoal,
      clearGoal,
    }),
  },
}));

import { GoalBar } from './GoalBar';

describe('GoalBar 上游恢复状态与立即重试', () => {
  let root: Root;
  let container: HTMLElement;

  beforeEach(() => {
    const { window } = parseHTML('<!doctype html><html><body><div id="root"></div></body></html>');
    globalThis.window = window as unknown as Window & typeof globalThis;
    globalThis.document = window.document as unknown as Document;
    container = document.getElementById('root')!;
    root = createRoot(container);
    retryUpstreamNow.mockClear();
    abort.mockClear();
  });

  afterEach(() => {
    act(() => root.unmount());
  });

  it('瞬态上游故障显示等待上游恢复文案与立即重试按钮，点击触发 retryUpstreamNow', () => {
    const at = new Date(2026, 4, 1, 14, 30, 0).getTime();
    act(() => {
      root.render(
        <GoalBar
          conversationId="c1"
          goal={{
            text: '完成发布',
            status: 'waiting',
            autoTurns: 1,
            noProgressRuns: 0,
            retry: {
              reason: 'upstream',
              kind: 'transient',
              provider: 'anthropic',
              attempt: 2,
              since: at - 60_000,
              at,
              lastError: '503 No available accounts',
            },
          }}
        />
      );
    });

    expect(container.textContent).toContain('Waiting for upstream recovery');
    expect(container.textContent).toContain('14:30');
    const retryBtn = container.querySelector(
      '[data-enso="upstream-retry-now"]'
    ) as HTMLButtonElement;
    expect(retryBtn).toBeTruthy();
    act(() => {
      retryBtn.click();
    });
    expect(retryUpstreamNow).toHaveBeenCalledWith('c1');
  });

  it('配额耗尽显示 Quota exhausted 文案，停止按钮调用 abort 终止自动重试', () => {
    const at = new Date(2026, 4, 1, 15, 0, 0).getTime();
    act(() => {
      root.render(
        <GoalBar
          conversationId="c2"
          goal={{
            text: '跑回归',
            status: 'waiting',
            autoTurns: 0,
            noProgressRuns: 0,
            retry: {
              reason: 'upstream',
              kind: 'quota',
              provider: 'openai',
              attempt: 1,
              since: at - 1_800_000,
              at,
              lastError: '403 weekly usage limit exceeded',
            },
          }}
        />
      );
    });

    expect(container.textContent).toContain('Quota exhausted');
    expect(container.textContent).toContain('15:00');
    const stopBtn = container.querySelector('[data-enso="upstream-stop"]') as HTMLButtonElement;
    expect(stopBtn).toBeTruthy();
    act(() => {
      stopBtn.click();
    });
    expect(abort).toHaveBeenCalledWith('c2');
  });
});
