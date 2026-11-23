import { parseHTML } from 'linkedom';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/i18n', () => ({
  useI18n: () => ({
    locale: 'zh',
    t: (key: string, params?: Record<string, string | number>) =>
      params ? key.replace(/\{\{(\w+)\}\}/g, (_, k: string) => String(params[k] ?? '')) : key,
  }),
}));

vi.mock('@/stores/sessions', () => ({
  useSessionsStore: {
    getState: () => ({
      retryUpstreamNow: vi.fn(),
      abort: vi.fn(),
      pauseGoal: vi.fn(),
      resumeGoal: vi.fn(),
      clearGoal: vi.fn(),
    }),
  },
}));

import { useSessionRemindersStore } from '@/stores/sessionReminders';
import { GoalBar } from './GoalBar';

describe('GoalBar 等提醒状态展示', () => {
  let root: Root;
  let container: HTMLElement;
  const NOW = new Date(2026, 4, 1, 14, 20, 0).getTime();

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    const { window } = parseHTML('<!doctype html><html><body><div id="root"></div></body></html>');
    globalThis.window = window as unknown as Window & typeof globalThis;
    globalThis.document = window.document as unknown as Document;
    container = document.getElementById('root')!;
    root = createRoot(container);
    useSessionRemindersStore.setState({ byConversation: {} });
  });

  afterEach(() => {
    act(() => root.unmount());
    vi.useRealTimers();
  });

  it('空闲 + active goal + 未到点提醒显示等提醒与钟点、label 和悬停剩余时间，切回 running 后恢复推进中', () => {
    const dueAt = new Date(2026, 4, 1, 14, 23, 0).getTime();
    const fullLabel = '检查合并后首轮新版 Beta (#153) 运行结果';
    useSessionRemindersStore
      .getState()
      .replace('45b1a6d7', [{ id: 'r00000001', dueAt, label: fullLabel }]);

    act(() => {
      root.render(
        <GoalBar
          conversationId="45b1a6d7"
          sessionStatus="idle"
          goal={{
            text: '等新版 Beta 跑完',
            status: 'active',
            autoTurns: 2,
            noProgressRuns: 0,
          }}
        />
      );
    });

    const indicator = container.querySelector('[data-enso="goal-reminder-waiting"]');
    expect(indicator).toBeTruthy();
    expect(indicator?.textContent).toContain('Waiting for reminder · 14:23');
    expect(indicator?.textContent).toContain(fullLabel);
    expect(indicator?.getAttribute('title')).toContain(fullLabel);
    expect(indicator?.getAttribute('title')).toContain('3m');
    expect(container.textContent).not.toContain('working');
    expect(container.innerHTML).not.toContain('animate-pulse');
    expect(container.innerHTML).not.toContain('animate-spin');

    // 提醒到点开始新一轮后切回推进中（working）
    act(() => {
      useSessionRemindersStore.getState().replace('45b1a6d7', []);
      root.render(
        <GoalBar
          conversationId="45b1a6d7"
          sessionStatus="running"
          goal={{
            text: '等新版 Beta 跑完',
            status: 'active',
            autoTurns: 2,
            noProgressRuns: 0,
          }}
        />
      );
    });

    expect(container.querySelector('[data-enso="goal-reminder-waiting"]')).toBeNull();
    expect(container.textContent).toContain('working');
    expect(container.innerHTML).toContain('animate-pulse');
  });
});
