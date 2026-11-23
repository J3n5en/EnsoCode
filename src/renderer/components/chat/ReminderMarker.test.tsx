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

import { useSessionRemindersStore } from '@/stores/sessionReminders';
import { ReminderMarker } from './ReminderMarker';

describe('ReminderMarker 侧栏等提醒标记', () => {
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

  it('空闲且有未到点提醒时显示静态等提醒徽标与悬停详情，切回 running 后隐藏', () => {
    const dueAt = new Date(2026, 4, 1, 14, 23, 0).getTime();
    const fullLabel = '检查合并后首轮新版 Beta (#153) 运行结果';
    useSessionRemindersStore
      .getState()
      .replace('45b1a6d7', [{ id: 'r00000001', dueAt, label: fullLabel }]);

    act(() => {
      root.render(<ReminderMarker conversationId="45b1a6d7" running={false} />);
    });

    const marker = container.querySelector('[data-enso="sidebar-reminder-waiting"]');
    expect(marker).toBeTruthy();
    expect(marker?.textContent).toContain('Waiting for reminder · 14:23');
    expect(marker?.getAttribute('title')).toContain(fullLabel);
    expect(marker?.getAttribute('title')).toContain('3m');
    expect(container.innerHTML).not.toContain('animate-spin');
    expect(container.innerHTML).not.toContain('animate-pulse');

    act(() => {
      root.render(<ReminderMarker conversationId="45b1a6d7" running />);
    });
    expect(container.querySelector('[data-enso="sidebar-reminder-waiting"]')).toBeNull();
  });
});
