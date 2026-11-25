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

describe('SecretaryRunningList 等待上游恢复与立即重试', () => {
  let root: Root;
  let container: HTMLElement;
  const retryUpstreamNow = vi.fn(async () => ({ ok: true }));

  beforeEach(() => {
    const { window } = parseHTML('<!doctype html><html><body><div id="root"></div></body></html>');
    (window as unknown as Record<string, unknown>).electronAPI = {
      agent: { retryUpstreamNow },
      secretary: { markResult: vi.fn() },
    };
    globalThis.window = window as unknown as Window & typeof globalThis;
    globalThis.document = window.document as unknown as Document;
    container = document.getElementById('root')!;
    root = createRoot(container);
    retryUpstreamNow.mockClear();
  });

  afterEach(() => {
    act(() => root.unmount());
  });

  it('看板卡片显示等待上游恢复和下次时间，并可点击立即重试', () => {
    const at = new Date(2026, 4, 1, 16, 45, 0).getTime();
    const card: SecretaryCard = {
      kind: 'session',
      conversationId: 'c1',
      projectId: 'p1',
      projectName: 'EnsoCode',
      title: '自动修复构建',
      state: 'idle',
      startedAt: at - 120_000,
      stateSince: at - 60_000,
      secretaryConversationId: 'sec-1',
      continuing: true,
      upstreamRetry: {
        reason: 'upstream',
        kind: 'transient',
        provider: 'anthropic',
        attempt: 1,
        since: at - 60_000,
        at,
        lastError: '503 No available accounts',
      },
    };

    act(() => {
      mockRunning = [card];
      root.render(<SecretaryRunningList />);
    });

    expect(container.textContent).toContain('Waiting for upstream recovery');
    expect(container.textContent).toContain('16:45');
    const btn = container.querySelector(
      '[data-enso="secretary-upstream-retry-now"]'
    ) as HTMLButtonElement;
    expect(btn).toBeTruthy();
    act(() => {
      btn.click();
    });
    expect(retryUpstreamNow).toHaveBeenCalledWith('c1');
  });
});
