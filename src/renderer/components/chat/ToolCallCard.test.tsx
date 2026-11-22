import { parseHTML } from 'linkedom';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TimelineItem } from '@/stores/sessions/timeline';
import { TimelineRow } from './TimelineRow';

vi.mock('@/i18n', () => ({
  useI18n: () => ({ t: (key: string) => key, locale: 'en' }),
}));
vi.mock('@/stores/settings', () => ({
  useSettingsStore: (select: (state: object) => unknown) =>
    select({ projects: [], compactReadOnlyTools: false, expandLiveEdits: false }),
}));
vi.mock('@/stores/sessions', () => ({
  useSessionsStore: (select: (state: object) => unknown) =>
    select({ activeId: null, conversations: {}, selectConversation: () => undefined }),
}));
vi.mock('@/stores/secretary', () => ({
  focusedSecretaryId: () => undefined,
  useSecretaryStore: (select: (state: object) => unknown) =>
    select({ secretary: { board: { todos: [] }, proposals: {} }, resolving: {} }),
}));
// 只认标题和代码围栏，够看出 markdown 落在哪个框里
vi.mock('./Markdown', () => ({
  Markdown: ({ text }: { text: string }) => {
    const nodes: ReturnType<typeof createElement>[] = [];
    let fence: string[] | null = null;
    text.split('\n').forEach((line, index) => {
      if (line.startsWith('```')) {
        if (fence) nodes.push(createElement('pre', { key: index }, fence.join('\n')));
        fence = fence ? null : [];
      } else if (fence) fence.push(line);
      else if (line.startsWith('## '))
        nodes.push(createElement('h2', { key: index }, line.slice(3)));
      else if (line.trim()) nodes.push(createElement('p', { key: index }, line));
    });
    return createElement('div', { 'data-markdown': 'true' }, nodes);
  },
}));

const PROMPT = [
  '先读日志再动手。',
  '',
  '## 现象',
  '切到精简版就崩。',
  '',
  '```',
  "TypeError: reading 'agent'",
  '```',
  '',
  '- 补回归测试',
  '- 不碰主检出',
  '',
  '## 汇报',
  '最后一行：PR 号。',
].join('\n');

function tool(name: string, args: unknown, output: unknown = null): TimelineItem {
  return {
    kind: 'tool',
    key: `tool-${name}`,
    name,
    summary: name,
    args,
    output: output === null ? null : JSON.stringify(output),
    state: 'ok',
    edits: null,
    writeContent: null,
    todos: null,
    durationMs: 0,
    agentMeta: null,
  } as TimelineItem;
}

let root: Root;
let container: HTMLElement;

beforeEach(() => {
  const { window } = parseHTML('<html><body><div id="root"></div></body></html>');
  vi.stubGlobal('window', window);
  vi.stubGlobal('document', window.document);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  container = window.document.getElementById('root') as unknown as HTMLElement;
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  vi.unstubAllGlobals();
});

const q = (enso: string) => container.querySelector(`[data-enso="${enso}"]`);

async function render(item: TimelineItem, secretarySession: boolean) {
  await act(async () => root.render(createElement(TimelineRow, { item, secretarySession })));
}

async function click(enso: string) {
  const el = q(enso) as HTMLElement | null;
  if (!el) throw new Error(`missing ${enso}`);
  await act(async () => el.click());
}

describe('秘书派活卡片：指令收进卡片框内', () => {
  const create = tool(
    'session_create',
    {
      title: '精简版崩溃',
      projectId: 'p1',
      worktree: true,
      checkout: '/Users/me/project/enso-code',
      branch: 'fix/lite',
      model: 'anthropic/claude',
      goal: '查清根因、修复、补回归测试，'.repeat(10),
      prompt: PROMPT,
    },
    { status: 'created', conversationId: 'conv-new' }
  );

  it('展开卡片后详情在卡片自己的框里，派发指令默认折叠、不渲染全文', async () => {
    await render(create, true);
    await click('tool-card-expand');
    const body = q('tool-card-body');
    expect(body?.getAttribute('data-framed')).toBe('true');
    expect(body?.getAttribute('class')).toMatch(/\bborder\b/);
    // 和普通工具行的展开详情同一种框：不加阴影，指令段不再套第二层框
    expect(body?.getAttribute('class')).not.toMatch(/shadow/);
    const prompt = q('tool-card-prompt');
    expect(prompt && body?.contains(prompt)).toBe(true);
    expect(prompt?.getAttribute('class')).not.toMatch(/\bborder\b|rounded|bg-/);
    expect(prompt?.textContent).toContain('Dispatch instructions');
    expect(prompt?.getAttribute('data-open')).toBe('false');
    expect(q('tool-card-prompt-body')).toBeNull();
    expect(container.querySelector('[data-markdown]')).toBeNull();
    expect(container.querySelector('h2')).toBeNull();
    const preview = q('tool-card-prompt-preview');
    expect(preview?.textContent).toContain('先读日志再动手。');
    expect(preview?.textContent).not.toContain('##');
    expect(container.textContent).not.toContain('最后一行：PR 号。');
    expect(prompt?.textContent).toContain('Copy');
  });

  it('点「展开全文」后才渲染全文：标题降级、代码块和列表都在限高可滚动的框内', async () => {
    await render(create, true);
    await click('tool-card-expand');
    await click('tool-card-prompt-toggle');
    const prompt = q('tool-card-prompt');
    const box = q('tool-card-prompt-body');
    expect(prompt?.getAttribute('data-open')).toBe('true');
    expect(box && prompt?.contains(box)).toBe(true);
    expect(box?.getAttribute('class')).toMatch(/max-h-/);
    expect(box?.getAttribute('class')).toMatch(/overflow-y-auto/);
    expect(box?.getAttribute('style')?.replace(/\s/g, '')).toContain('--chat-h2-size:1em');
    const headings = [...container.querySelectorAll('h2')];
    expect(headings.map((h) => h.textContent)).toEqual(['现象', '汇报']);
    expect(headings.every((h) => box?.contains(h))).toBe(true);
    const pre = container.querySelector('pre');
    expect(pre && box?.contains(pre)).toBe(true);
    expect(box?.textContent).toContain('最后一行：PR 号。');
    await click('tool-card-prompt-toggle');
    expect(q('tool-card-prompt-body')).toBeNull();
  });

  it('字段区紧凑：路径单行截断带悬停全文，长目标默认截断可展开', async () => {
    await render(create, true);
    await click('tool-card-expand');
    const values = [...container.querySelectorAll('[data-enso="tool-card-kv-value"]')];
    const path = values.find((el) => el.getAttribute('data-display') === 'path');
    expect(path?.getAttribute('title')).toBe('/Users/me/project/enso-code');
    expect(path?.getAttribute('class')).toMatch(/\btruncate\b/);
    const goal = values.find((el) => el.getAttribute('data-display') === 'long');
    expect(goal?.querySelector('.line-clamp-2')).not.toBeNull();
    expect(container.textContent).toContain('anthropic/claude');
    await click('tool-card-kv-toggle');
    expect(goal?.querySelector('.line-clamp-2')).toBeNull();
  });

  it('session_send 的消息同样收进框里，默认折叠', async () => {
    await render(
      tool(
        'session_send',
        { conversationId: 'conv-1', message: PROMPT, goal: '修好再汇报' },
        { status: 'sent' }
      ),
      true
    );
    await click('tool-card-expand');
    expect(q('tool-card-body')?.getAttribute('data-framed')).toBe('true');
    const prompt = q('tool-card-prompt');
    expect(prompt?.textContent).toContain('Message');
    expect(prompt?.getAttribute('data-open')).toBe('false');
    expect(container.querySelector('h2')).toBeNull();
    expect(container.textContent).toContain('修好再汇报');
    await click('tool-card-prompt-toggle');
    const box = q('tool-card-prompt-body');
    expect([...container.querySelectorAll('h2')].every((h) => box?.contains(h))).toBe(true);
  });

  it('todo_item_dispatch 用同一套指令框', async () => {
    await render(
      tool('todo_item_dispatch', { todoId: 't1', projectId: 'p1', prompt: PROMPT }),
      true
    );
    await click('tool-card-expand');
    expect(q('tool-card-prompt')?.getAttribute('data-open')).toBe('false');
  });
});

describe('普通会话不受影响', () => {
  it('普通会话里的 session_create 与 bash 仍是原来的工具行，没有卡片框', async () => {
    for (const item of [
      tool('session_create', { prompt: PROMPT }),
      tool('bash', { command: 'ls' }, 'ok'),
    ]) {
      await render(item, false);
      expect(q('tool-row')).not.toBeNull();
      expect(q('tool-card')).toBeNull();
      expect(q('tool-card-prompt')).toBeNull();
    }
  });

  it('普通会话里的收尾卡片展开后不套秘书卡片框', async () => {
    await render(
      tool('task_settle', { tasks: [{ taskId: 'task-1', action: 'stop', reason: '不用了' }] }),
      false
    );
    await click('tool-card-expand');
    expect(q('tool-card-body')).not.toBeNull();
    expect(q('tool-card-body')?.getAttribute('data-framed')).toBeNull();
  });
});
