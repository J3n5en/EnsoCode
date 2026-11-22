import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { TimelineItem } from '@/stores/sessions/timeline';
import { TimelineRow } from './TimelineRow';

vi.mock('@/i18n', () => ({ useI18n: () => ({ t: (key: string) => `[${key}]` }) }));
vi.mock('@/stores/settings', () => ({
  useSettingsStore: (select: (state: object) => unknown) =>
    select({ compactReadOnlyTools: false, expandLiveEdits: false }),
}));
vi.mock('@/stores/sessions', () => ({ useSessionsStore: () => null }));
vi.mock('./Markdown', () => ({ Markdown: () => null }));

const row = (over: Partial<Extract<TimelineItem, { kind: 'tool' }>>): string =>
  renderToStaticMarkup(
    createElement(TimelineRow, {
      item: {
        kind: 'tool',
        key: 'tool-subagent',
        name: 'subagent',
        summary: '',
        output: '{"run":{"agentId":"a","runId":"r1"}}',
        state: 'ok',
        edits: null,
        writeContent: null,
        todos: null,
        agentMeta: null,
        startedAt: null,
        durationMs: 0,
        ...over,
      },
    })
  );

describe('子代理操作行头', () => {
  it('动作在前、子代理标题在后', () => {
    const html = row({ summary: '子代理连通性测试', subagentOp: 'report' });
    expect(html).toContain('[Read report] · 子代理连通性测试');
    expect(html).not.toContain('runId');
  });

  it('没有标题时只显示动作', () => {
    expect(row({ subagentOp: 'list' })).toContain('>[List agents]</span>');
  });

  it('resume 显示动作与标题，不把参数 JSON 当行头', () => {
    const html = row({ summary: '顺序执行 6 步', subagentOp: 'resume' });
    expect(html).toContain('[Resume agent] · 顺序执行 6 步');
    expect(html).not.toContain('operation');
  });

  it('出错时照旧显示错误首行', () => {
    const html = row({
      summary: 'reviewer',
      subagentOp: 'wait',
      state: 'error',
      output: 'Run was not found\nmore',
    });
    expect(html).toContain('>Run was not found</span>');
    expect(html).not.toContain('[Wait]');
  });

  it('参数校验失败（没有摘要）时也显示错误首行', () => {
    const html = row({
      state: 'error',
      output:
        'Validation failed for tool "subagent":\n  - operation: must have required properties operation\n\nReceived arguments:\n{}',
    });
    expect(html).toContain('>Validation failed for tool &quot;subagent&quot;:</span>');
  });
});
