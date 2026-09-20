import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { RtkToolStatsBar } from './RtkToolStatsBar';

vi.mock('@/i18n', () => ({
  useI18n: () => ({
    t: (key: string, params?: Record<string, string | number>) =>
      key.replace(/\{\{(\w+)\}\}/g, (token, name: string) => String(params?.[name] ?? token)),
  }),
}));

const render = (value: unknown): string =>
  renderToStaticMarkup(createElement(RtkToolStatsBar, { value }));

describe('RtkToolStatsBar', () => {
  it('作为输出 footer 展示状态和估算，不重复命令或提供独立展开按钮', () => {
    const html = render({
      status: 'compressed',
      originalCommand: 'git status --short',
      rewrittenCommand: 'rtk git status --short',
      inputTokens: 800,
      outputTokens: 200,
      reason: 'supported command',
    });

    expect(html).toContain('data-rtk-status="compressed"');
    expect(html).not.toContain('<button');
    expect(html).not.toContain('aria-expanded');
    expect(html).toContain('RTK');
    expect(html).toContain('~600 tokens saved');
    expect(html).toContain('(75%)');
    expect(html).not.toContain('Original command');
    expect(html).not.toContain('Rewritten command');
    expect(html).not.toContain('git status --short');
    expect(html).toContain('Input estimate');
    expect(html).toContain('Output estimate');
    expect(html).toContain('supported command');
  });

  it('未知计数只显示状态，不伪装成零节省', () => {
    const html = render({
      status: 'unavailable',
      originalCommand: 'custom-command',
      reason: 'unsupported command',
    });

    expect(html).toContain('Unavailable');
    expect(html).not.toContain('tokens saved');
    expect(html).not.toContain('(0%)');
  });

  it('pending 明确表示后台任务已启动，并指向 task_output 的最终统计', () => {
    const html = render({ status: 'pending', originalCommand: 'pnpm test &' });

    expect(html).toContain('Background task started');
    expect(html).toContain(
      'This is the startup receipt; see the task_output result for final statistics.'
    );
    expect(html).not.toContain('>Pending<');
  });

  it('无效或缺失 RTK 元数据时不增加工具状态栏', () => {
    expect(render(undefined)).toBe('');
    expect(render({ status: 'compressed' })).toBe('');
  });
});
