import { SHELL_TIMEOUT_HINT } from '@shared/shellTimeoutHint';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { TimelineItem } from '@/stores/sessions/timeline';
import { TimelineRow } from './TimelineRow';

vi.mock('@/i18n', () => ({
  useI18n: () => ({ t: (key: string) => key, locale: 'en' }),
}));
vi.mock('@/stores/settings', () => ({
  useSettingsStore: (select: (state: object) => unknown) =>
    select({
      projects: [{ id: 'p1', name: 'proj', alias: '', path: '/tmp/p', kind: 'local' }],
      compactReadOnlyTools: false,
      expandLiveEdits: false,
    }),
}));
vi.mock('@/stores/sessions', () => ({
  useSessionsStore: (select: (state: object) => unknown) =>
    select({
      activeId: 'conv-1',
      conversations: { 'conv-1': { projectId: 'p1' } },
      selectConversation: () => undefined,
    }),
}));
vi.mock('@/stores/secretary', () => ({
  useSecretaryStore: (select: (state: object) => unknown) =>
    select({ secretary: { board: { todos: [] }, proposals: {} }, resolving: {} }),
}));
vi.mock('./Markdown', () => ({ Markdown: ({ text }: { text: string }) => text }));

function tool(name: string, over: Record<string, unknown> = {}): TimelineItem {
  return {
    kind: 'tool',
    key: `tool-${name}`,
    name,
    summary: name,
    output: null,
    state: 'ok',
    edits: null,
    writeContent: null,
    todos: null,
    durationMs: 0,
    agentMeta: null,
    ...over,
  } as TimelineItem;
}

describe('普通会话的工具行', () => {
  it('mcp 和 bash 都走原来的工具行，不画秘书可读卡片', () => {
    for (const name of ['mcp__fast_context__fast_context_search', 'bash']) {
      const markup = renderToStaticMarkup(createElement(TimelineRow, { item: tool(name) }));
      expect(markup, name).toContain('data-enso="tool-row"');
      expect(markup, name).not.toContain('data-enso="tool-card"');
    }
  });
});

/** 卡片标题那一格（工具名后的 font-mono 文本） */
function headline(item: TimelineItem): string {
  const markup = renderToStaticMarkup(createElement(TimelineRow, { item }));
  const match = /<span class="min-w-0 flex-1 truncate font-mono[^"]*">([^<]*)<\/span>/.exec(markup);
  return match?.[1] ?? '';
}

describe('命令失败卡片标题', () => {
  it('输出以 timeout 提示开头时，标题跳过提示和空行，显示真实错误', () => {
    const output = `${SHELL_TIMEOUT_HINT}\n\nError: Cannot find module 'x'\n\nCommand exited with code 1`;
    expect(headline(tool('bash', { state: 'error', output }))).toBe(
      'Error: Cannot find module &#x27;x&#x27;'
    );
  });

  it('没有 timeout 提示时仍取输出第一行', () => {
    const output = 'head: command not found\nCommand exited with code 1';
    expect(headline(tool('powershell', { state: 'error', output }))).toBe(
      'head: command not found'
    );
  });

  it('成功时标题仍是命令摘要，不受输出里的提示影响', () => {
    const output = `${SHELL_TIMEOUT_HINT}\n\nok`;
    expect(headline(tool('bash', { state: 'ok', output, summary: 'pnpm build' }))).toBe(
      'pnpm build'
    );
  });
});
