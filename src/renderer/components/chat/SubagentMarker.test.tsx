import { parseHTML } from 'linkedom';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useSubagentRunsStore } from '@/stores/subagentRuns';
import { SubagentMarker } from './SubagentMarker';

vi.mock('@/i18n', () => ({
  useI18n: () => ({
    locale: 'zh-CN',
    t: (key: string, params?: Record<string, string | number>) =>
      params ? key.replace(/\{\{(\w+)\}\}/g, (_, k) => String(params[k] ?? '')) : key,
  }),
}));

describe('SubagentMarker', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    const { window } = parseHTML('<!doctype html><html><body><div id="root"></div></body></html>');
    Object.assign(globalThis, {
      window,
      document: window.document,
      HTMLElement: window.HTMLElement,
      Node: window.Node,
      IS_REACT_ACT_ENVIRONMENT: true,
    });
    container = window.document.getElementById('root') as HTMLDivElement;
    root = createRoot(container);
    useSubagentRunsStore.setState({ byConversation: {} });
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
  });

  it('无在跑子代理时不渲染', async () => {
    await act(async () => {
      root.render(<SubagentMarker conversationId="c1" />);
    });
    expect(container.innerHTML).toBe('');
  });

  it('有在跑子代理时显示耗时标记与包含子代理名和分钟数的提示', async () => {
    useSubagentRunsStore.getState().replace('c1', [
      {
        agentId: 'a1',
        runId: 'r1',
        title: '实现子代理',
        status: 'running',
        elapsedMs: 6 * 60_000,
      },
    ]);
    await act(async () => {
      root.render(<SubagentMarker conversationId="c1" />);
    });
    const marker = container.querySelector('[data-enso="session-subagent-marker"]');
    expect(marker).not.toBeNull();
    expect(marker?.textContent).toContain('6m');
    expect(marker?.getAttribute('title')).toContain('实现子代理');
    expect(marker?.getAttribute('title')).toContain('6');
  });
});
