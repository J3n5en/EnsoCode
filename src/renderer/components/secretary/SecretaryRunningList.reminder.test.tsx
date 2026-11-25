import type { SecretaryCard } from '@shared/types/secretary';
import { parseHTML } from 'linkedom';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/i18n', () => ({
  useI18n: () => ({
    locale: 'zh',
    tNode: (key: string, params?: Record<string, unknown>) => {
      const parts: unknown[] = [];
      const regex = /\{\{(\w+)\}\}/g;
      let last = 0;
      let m: RegExpExecArray | null = regex.exec(key);
      while (m) {
        if (m.index > last) parts.push(key.slice(last, m.index));
        parts.push(params?.[m[1]] ?? m[0]);
        last = m.index + m[0].length;
        m = regex.exec(key);
      }
      if (last < key.length) parts.push(key.slice(last));
      return parts;
    },
    t: (key: string, params?: Record<string, string | number>) =>
      params ? key.replace(/\{\{(\w+)\}\}/g, (_, k: string) => String(params[k] ?? '')) : key,
  }),
}));

vi.mock('@/stores/settings', () => ({
  useSettingsStore: (selector: (s: { providers: [] }) => unknown) => selector({ providers: [] }),
}));

let mockRunning: SecretaryCard[] = [];

vi.mock('@/stores/secretary', () => ({
  useSecretaryStore: (
    selector: (s: {
      secretary: { board: { running: SecretaryCard[] } };
      states: Record<string, never>;
      focusedId: null;
    }) => unknown
  ) => selector({ secretary: { board: { running: mockRunning } }, states: {}, focusedId: null }),
}));

vi.mock('@/stores/sessions', () => ({
  useSessionsStore: (selector: (s: { conversations: Record<string, never> }) => unknown) =>
    selector({ conversations: {} }),
}));

vi.mock('@/stores/sessionPeek', () => ({
  openSessionPeek: vi.fn(),
}));

import { SecretaryRunningList } from './SecretaryRunningList';

describe('SecretaryRunningList 等提醒状态展示', () => {
  let root: Root;
  let container: HTMLElement;
  const NOW = new Date(2026, 4, 1, 14, 20, 0).getTime();

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    const { window } = parseHTML('<!doctype html><html><body><div id="root"></div></body></html>');
    (window as unknown as Record<string, unknown>).electronAPI = {
      agent: { retryUpstreamNow: vi.fn() },
      secretary: { markResult: vi.fn() },
    };
    globalThis.window = window as unknown as Window & typeof globalThis;
    globalThis.document = window.document as unknown as Document;
    container = document.getElementById('root')!;
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    vi.useRealTimers();
  });

  it('空闲挂着未到点提醒时显示等提醒与钟点、不显示续跑中/运行中，到点开新一轮后切回运行中', () => {
    const dueAt = new Date(2026, 4, 1, 14, 23, 0).getTime();
    const fullLabel = '检查合并后首轮新版 Beta (#153) 运行结果';
    const waitingCard: SecretaryCard = {
      kind: 'session',
      conversationId: '45b1a6d7',
      projectId: 'p1',
      projectName: 'EnsoCode',
      title: 'Beta mac 构建排队',
      state: 'idle',
      startedAt: NOW - 120_000,
      stateSince: NOW - 30_000,
      secretaryConversationId: 'sec-1',
      pendingReminder: {
        id: 'r00000001',
        dueAt,
        label: fullLabel,
        count: 1,
      },
    };

    act(() => {
      mockRunning = [waitingCard];
      root.render(<SecretaryRunningList />);
    });

    const badge = container.querySelector('[data-enso="secretary-reminder-waiting"]');
    expect(badge).toBeTruthy();
    expect(badge?.textContent).toContain('Waiting for reminder · 14:23');
    expect(badge?.getAttribute('title')).toContain(fullLabel);
    expect(badge?.getAttribute('title')).toContain('3m');
    expect(container.textContent).toContain(fullLabel);
    expect(container.textContent).not.toContain('Continuing');
    expect(container.textContent).not.toContain('Running');
    expect(container.innerHTML).not.toContain('animate-spin');

    // 提醒到点开始新一轮：状态切回 Running
    const runningCard: SecretaryCard = {
      ...waitingCard,
      state: 'running',
      pendingReminder: undefined,
    };
    act(() => {
      mockRunning = [runningCard];
      root.render(<SecretaryRunningList />);
    });

    expect(container.querySelector('[data-enso="secretary-reminder-waiting"]')).toBeNull();
    expect(container.querySelector('[data-enso="secretary-running-badge"]')?.textContent).toBe(
      'Running'
    );
  });
});
