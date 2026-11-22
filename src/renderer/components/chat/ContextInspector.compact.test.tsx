import type { ContextOccupancy } from '@shared/types/agent';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { ContextInspector } from './ContextInspector';

const harness = vi.hoisted(() => ({ conversation: {} as Record<string, unknown> }));
vi.mock('@/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock('@/lib/sidePanelDock', () => ({ openSidePanelFile: vi.fn() }));
vi.mock('@/stores/sessions', () => ({
  useSessionsStore: (select: (state: object) => unknown) =>
    select({ conversations: { c: harness.conversation } }),
}));

const occupancy = {
  buckets: {},
  used: 1000,
  estimated: true,
  compactedMessageCount: 0,
  compactionModelMismatch: false,
  contextWindow: 200_000,
} as unknown as ContextOccupancy;

const button = (conversation: Record<string, unknown>) => {
  harness.conversation = conversation;
  const html = renderToStaticMarkup(
    createElement(ContextInspector, { occupancy, conversationId: 'c' })
  );
  return /<button[^>]*>[^<]*<\/button>\s*<\/div>$/.exec(html)?.[0] ?? '';
};

describe('ContextInspector 压缩按钮', () => {
  it('可压缩时可点', () => {
    const html = button({ started: true });
    expect(html).toContain('>Compact context<');
    expect(html).not.toContain(' disabled=""');
  });

  it.each([
    ['running', 'Compacting…', 'Compaction already in progress'],
    ['queued', 'Compacts after this turn', 'Compaction is queued and runs after this turn'],
  ])('%s 时禁用，原因写在按钮文字里', (compaction, label, title) => {
    const html = button({ started: true, compaction });
    expect(html).toContain(' disabled=""');
    expect(html).toContain(`>${label}<`);
    expect(html).toContain(`title="${title}"`);
  });

  it('工作区操作中禁用，文字说明原因（触屏看不到 title）', () => {
    const html = button({ started: true, workspaceMigrating: true });
    expect(html).toContain(' disabled=""');
    expect(html).toContain('>Workspace operation in progress<');
  });

  it('会话未启动不渲染按钮', () => {
    expect(button({ started: false })).toBe('');
  });
});
