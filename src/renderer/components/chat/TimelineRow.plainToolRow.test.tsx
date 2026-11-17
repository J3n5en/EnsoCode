import { SHELL_READ_HINT, SHELL_TIMEOUT_HINT } from '@shared/shellHints';
import type { ProjectedMessage } from '@shared/types/agent';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { buildTimeline, type TimelineItem } from '@/stores/sessions/timeline';
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

  it('读文件提示和前面成功命令的输出不占标题，显示真实报错', () => {
    const output = `${SHELL_READ_HINT}\n\nimport { a } from './a';\nls: lib: No such file or directory\n\nCommand exited with code 1`;
    expect(headline(tool('bash', { state: 'error', output }))).toBe(
      'ls: lib: No such file or directory'
    );
  });
});

/** 一次 bash 调用的时间线行；result 缺省表示结果还没回来 */
function bashRow(
  running: boolean,
  result?: { output: string; isError: boolean }
): Extract<TimelineItem, { kind: 'tool' }> {
  const messages: ProjectedMessage[] = [
    { role: 'user', content: [{ type: 'text', text: 'run' }] },
    {
      role: 'assistant',
      content: [{ type: 'toolCall', id: 'c1', name: 'bash', arguments: { command: 'pnpm lint' } }],
    },
  ];
  if (result) {
    messages.push({
      role: 'toolResult',
      toolCallId: 'c1',
      toolName: 'bash',
      isError: result.isError,
      content: [{ type: 'text', text: result.output }],
    });
  }
  const row = buildTimeline(messages, running).find((item) => item.kind === 'tool');
  if (row?.kind !== 'tool') throw new Error('missing tool row');
  return row;
}

const looksFailed = (item: TimelineItem): boolean => {
  const markup = renderToStaticMarkup(createElement(TimelineRow, { item }));
  return markup.includes('text-destructive') || markup.includes('bg-destructive');
};

describe('工具行失败样式', () => {
  it('退出码 0 但输出含 error、stderr 有内容：不是失败样式', () => {
    const output = [
      'Checked 120 files in 80ms. No fixes applied.',
      'stderr | src/a.test.ts > logs an error',
      'Error: expected failure logged by the test',
      ' ✓ 12 passed',
    ].join('\n');
    const row = bashRow(false, { output, isError: false });
    expect(row.state).toBe('ok');
    expect(looksFailed(row)).toBe(false);
    expect(headline(row)).toBe('pnpm lint');
  });

  it('退出码非 0：仍是失败样式，标题是真实报错', () => {
    const output = 'src/a.ts:1:1 lint/style ━━━\n  × Found 1 error.\n\nCommand exited with code 1';
    const row = bashRow(false, { output, isError: true });
    expect(row.state).toBe('error');
    expect(looksFailed(row)).toBe(true);
    expect(headline(row)).toBe('× Found 1 error.');
  });

  it('运行中：结果回来之前不是失败样式', () => {
    const row = bashRow(true);
    expect(row.state).toBe('running');
    expect(looksFailed(row)).toBe(false);
  });
});
