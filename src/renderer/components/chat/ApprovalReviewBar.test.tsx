import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { ApprovalReviewBar } from './ApprovalReviewBar';

vi.mock('@/i18n', () => ({
  useI18n: () => ({
    t: (key: string, params?: Record<string, string | number>) =>
      key.replace(/\{\{(\w+)\}\}/g, (token, name: string) => String(params?.[name] ?? token)),
  }),
}));

const render = (value: unknown): string =>
  renderToStaticMarkup(createElement(ApprovalReviewBar, { value }));

describe('ApprovalReviewBar', () => {
  it('托管拒绝显示模型、三档概率与本地化理由', () => {
    const html = render({
      verdict: 'deny',
      model: 'jev-latest',
      allow: 0.67,
      ask: 0.1,
      block: 0.23,
      reason: 'unclear_target',
    });
    expect(html).toContain('data-approval-review="deny"');
    expect(html).toContain('Auto-managed · denied');
    expect(html).toContain('jev-latest');
    expect(html).toContain('allow 0.67');
    expect(html).toContain('block 0.23');
    expect(html).toContain('Unclear target or intent');
  });

  it('托管放行；无理由时不显示理由；脏数据不渲染', () => {
    const html = render({ verdict: 'allow', model: 'jev', allow: 0.95, ask: 0.05, block: 0 });
    expect(html).toContain('Auto-managed · allowed');
    expect(html).not.toContain('Reason');
    expect(render({ verdict: 'allow' })).toBe('');
    expect(render(undefined)).toBe('');
  });
});
