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
      projects: [
        { id: 'p1', name: 'sec-verify-proj', alias: '', path: '/tmp/p', kind: 'secretary' },
      ],
      compactReadOnlyTools: false,
      expandLiveEdits: false,
    }),
}));
// 可读卡片只在秘书会话里画：会话类型由上层显式传入，不看全局当前会话
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
    select({
      secretary: {
        board: { todos: [] },
        proposals: {
          pr1: {
            id: 'pr1',
            kind: 'dispatch',
            status: 'succeeded',
            draft: {
              projectId: 'p1',
              title: '写 hello.txt',
              prompt: '写 hello.txt',
              worktree: false,
            },
          },
        },
      },
      resolving: {},
      resolveProposal: () => undefined,
    }),
}));
vi.mock('./Markdown', () => ({ Markdown: ({ text }: { text: string }) => text }));

function tool(over: Record<string, unknown>): TimelineItem {
  return {
    kind: 'tool',
    key: 'tool-1',
    summary: '',
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

function classOf(markup: string, enso: string): string {
  const tag = markup.match(new RegExp(`<[^>]*data-enso="${enso}"[^>]*>`))?.[0] ?? '';
  return tag.match(/class="([^"]*)"/)?.[1] ?? '';
}

describe('工具卡片和结果卡片同宽', () => {
  it('session_create 的工具卡片和派活结果卡片没有左右缩进，并包在同一列里', () => {
    const markup = renderToStaticMarkup(
      createElement(TimelineRow, {
        secretarySession: true,
        item: tool({
          name: 'session_create',
          args: { title: '写 hello.txt', prompt: '写 hello.txt', projectId: 'p1', worktree: false },
          output: JSON.stringify({ status: 'awaiting_confirmation', proposalId: 'pr1' }),
        }),
      })
    );
    const pair = classOf(markup, 'tool-card-pair');
    const toolCard = classOf(markup, 'tool-card');
    const result = classOf(markup, 'secretary-proposal');
    expect(pair).toContain('w-full');
    expect(toolCard).toContain('w-full');
    expect(result).toContain('w-full');
    expect(toolCard).not.toMatch(/\bml-/);
    expect(result).not.toMatch(/\bml-/);
    expect(markup.indexOf('data-enso="tool-card"')).toBeGreaterThan(
      markup.indexOf('data-enso="tool-card-pair"')
    );
    expect(markup.indexOf('data-enso="secretary-proposal"')).toBeGreaterThan(
      markup.indexOf('data-enso="tool-card"')
    );
  });

  it('session_send 的送达状态和 todo 更新结果都在同一张满宽卡片里', () => {
    const sent = renderToStaticMarkup(
      createElement(TimelineRow, {
        secretarySession: true,
        item: tool({
          name: 'session_send',
          args: { conversationId: 'conv-1', message: '写好了' },
          output: JSON.stringify({ status: 'sent' }),
        }),
      })
    );
    const updated = renderToStaticMarkup(
      createElement(TimelineRow, {
        secretarySession: true,
        item: tool({
          name: 'todo_item_update',
          args: { todoId: 'todo-1', done: true },
          output: JSON.stringify({
            todoId: 'todo-1',
            before: { text: '补验收', done: false, dueAt: null, projectId: null },
            after: { text: '补验收', done: true, dueAt: null, projectId: null },
          }),
        }),
      })
    );
    for (const markup of [sent, updated]) {
      expect(classOf(markup, 'tool-card')).toContain('w-full');
      expect(classOf(markup, 'tool-card')).not.toMatch(/\bml-/);
      expect(markup.match(/data-enso="tool-card"/g)).toHaveLength(1);
    }
    expect(sent).toContain('data-enso="tool-card-status"');
    expect(sent).toContain('Delivered');
    expect(updated).toContain('data-open="false"');
    expect(updated).not.toContain('data-enso="tool-card-body"');
  });
});

describe('秘书卡片收成一行', () => {
  const created = () =>
    renderToStaticMarkup(
      createElement(TimelineRow, {
        secretarySession: true,
        item: tool({
          name: 'session_create',
          args: {
            title: '定时卡片与记忆列表悬停',
            prompt: '把定时卡片收起来',
            projectId: 'p1',
            worktree: false,
          },
          output: JSON.stringify({ status: 'created', conversationId: 'new-1' }),
        }),
      })
    );

  it('默认收起，只有一行标题和一枚状态徽标', () => {
    const markup = created();
    expect(markup).toContain('data-open="false"');
    // 一行：只有一个可点的行头，没有详情、键值和原始数据
    expect(markup.match(/data-enso="tool-card-expand"/g)).toHaveLength(1);
    expect(markup).not.toContain('data-enso="tool-card-body"');
    expect(markup).not.toContain('<dl');
    expect(markup).not.toContain('data-enso="tool-card-raw"');
    expect(markup).toContain('data-enso="tool-card-status"');
  });

  it('同一个状态只出现一次，会话块不再重复「已创建」', () => {
    const markup = created();
    expect(markup.match(/Created the session/g)).toHaveLength(1);
    expect(markup).not.toContain('Created 「');
  });

  it('详情默认不展开，键值和提示词都要点开才出现', () => {
    const markup = created();
    expect(markup).not.toContain('Worktree');
    expect(markup).not.toContain('把定时卡片收起来');
    expect(markup).not.toContain('View raw data');
  });
});
