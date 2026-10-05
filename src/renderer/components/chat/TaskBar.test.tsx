import type { BackgroundTaskInfo, SubagentActivity, SubagentInfo } from '@shared/types/agent';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { AgentActivityView, TaskBar } from './TaskBar';

vi.mock('@/i18n', () => ({
  useI18n: () => ({ t: (key: string) => key }),
}));
vi.mock('./Markdown', () => ({ Markdown: ({ text }: { text: string }) => text }));
vi.mock('@/stores/settings', () => ({
  useSettingsStore: (select: (state: { virtualModels: never[] }) => unknown) =>
    select({ virtualModels: [] }),
}));

const renderActivity = (activity: SubagentActivity): string =>
  renderToStaticMarkup(createElement(AgentActivityView, { activity }));

const task = (status: BackgroundTaskInfo['status']): BackgroundTaskInfo => ({
  taskId: 'task-1',
  command: 'pnpm dev',
  status,
  tail: '',
  startedAt: 0,
});

const agent = (status: SubagentInfo['status']): SubagentInfo => ({
  id: 'agent-1',
  description: 'scan repo',
  status,
  steps: 0,
  currentActivity: '',
  startedAt: 0,
});

const renderBar = (
  sessionId: string,
  tasks: BackgroundTaskInfo[],
  subagents: SubagentInfo[],
  readOnly?: boolean
) => renderToStaticMarkup(createElement(TaskBar, { sessionId, tasks, subagents, readOnly }));

describe('TaskBar', () => {
  it('首次出现即为终态的条目（重启后从快照/缓存恢复）不显示', () => {
    expect(renderBar('restored', [task('done')], [agent('failed')])).toBe('');
  });

  it('本次运行中见过 running 的条目结束后仍显示', () => {
    renderBar('live', [task('running')], [agent('running')]);
    const html = renderBar('live', [task('done')], [agent('done')]);
    expect(html).toContain('pnpm dev');
    expect(html).toContain('scan repo');
  });

  it('只读时仍显示运行中的条目，但不给停止按钮', () => {
    const writable = renderBar('rw', [task('running')], [agent('running')]);
    expect(writable).toContain('Stop task');
    expect(writable).toContain('Stop subagent');
    const html = renderBar('ro', [task('running')], [agent('running')], true);
    expect(html).toContain('pnpm dev');
    expect(html).toContain('scan repo');
    expect(html).not.toContain('Stop task');
    expect(html).not.toContain('Stop subagent');
  });
});

describe('AgentActivityView', () => {
  it('工具默认折叠，只在紧凑行显示名称、路径摘要和可访问状态', () => {
    const html = renderActivity({
      id: 'read-1',
      type: 'tool',
      toolName: 'read',
      argumentsText: '{\n  "path": "src/renderer/App.tsx",\n  "offset": 10\n}',
      outputText: 'FULL_RESULT_ONLY_WHEN_EXPANDED',
      status: 'done',
    });

    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('aria-controls="subagent-tool-read-1"');
    expect(html).toContain('aria-label="done"');
    expect(html).toContain('>read<');
    expect(html).toContain('src/renderer/App.tsx');
    expect(html).not.toContain('&quot;path&quot;');
    expect(html).not.toContain('FULL_RESULT_ONLY_WHEN_EXPANDED');
    expect(html).not.toContain('Arguments');
    expect(html).not.toContain('Result');
  });

  it('运行中的搜索工具显示 pattern 摘要和状态语义', () => {
    const html = renderActivity({
      id: 'grep-1',
      type: 'tool',
      toolName: 'grep',
      argumentsText: '{"path":"src","pattern":"AgentActivityView"}',
      status: 'running',
    });

    expect(html).toContain('AgentActivityView');
    expect(html).toContain('aria-label="running"');
    expect(html).toContain('title="AgentActivityView"');
  });

  it('MCP 工具折叠行只显示工具名，不带 mcp__server__ 前缀', () => {
    const html = renderActivity({
      id: 'mcp-1',
      type: 'tool',
      toolName: 'mcp__fast-context__fast_context_search',
      argumentsText: '{"query":"tool row"}',
      status: 'done',
    });

    expect(html).toContain('>fast_context_search<');
    expect(html).not.toContain('mcp__fast-context');
  });
});
