import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { TimelineItem } from '@/stores/sessions/timeline';
import { TimelineRow } from './TimelineRow';

const settings = vi.hoisted(() => ({ compactReadOnlyTools: false, expandLiveEdits: false }));

vi.mock('@/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock('@/stores/settings', () => ({
  useSettingsStore: (select: (state: object) => unknown) => select(settings),
}));
vi.mock('@/stores/sessions', () => ({ useSessionsStore: () => null }));
vi.mock('./Markdown', () => ({ Markdown: () => null }));
vi.mock('./EditDiff', () => ({ EditDiff: () => null }));
vi.mock('./ReadFileView', () => ({ ReadFileView: () => null }));

describe('RTK tool output footer', () => {
  it.each([false, true])('compactReadOnlyTools=%s 时 bash 仍保留完整外壳和原工具头', (compact) => {
    settings.compactReadOnlyTools = compact;
    const item: Extract<TimelineItem, { kind: 'tool' }> = {
      kind: 'tool',
      key: 'tool-rtk',
      name: 'bash',
      summary: 'git log -n 30',
      output: 'abc1234 Fix command output',
      state: 'ok',
      edits: null,
      writeContent: null,
      todos: null,
      agentMeta: null,
      startedAt: null,
      durationMs: 100,
      rtk: {
        status: 'compressed',
        originalCommand: 'git log -n 30',
        rewrittenCommand: 'rtk git log -n 30',
        inputTokens: 1682,
        outputTokens: 847,
      },
    };
    const html = renderToStaticMarkup(createElement(TimelineRow, { item }));

    expect(html).toContain('bash');
    expect(html).toContain('git log -n 30');
    expect(html).toContain('rounded-lg border border-border/60 bg-muted/30');
    expect(html).not.toContain('data-rtk-status');
    expect(html).not.toContain('abc1234 Fix command output');
    expect(html).toBe(
      renderToStaticMarkup(createElement(TimelineRow, { item: { ...item, rtk: undefined } }))
    );
    const readHtml = renderToStaticMarkup(
      createElement(TimelineRow, { item: { ...item, name: 'read', rtk: undefined } })
    );
    expect(readHtml.includes('rounded-lg border border-border/60 bg-muted/30')).toBe(!compact);
  });
});
